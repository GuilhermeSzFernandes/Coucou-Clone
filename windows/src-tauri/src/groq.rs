// Groq API client — an alternative to claude.rs for the island's chat.
//
// Groq speaks the OpenAI chat-completions format. The key lives in the Windows
// Credential Manager under "groq-api-key", exactly like the Anthropic one, and
// file bytes never cross the IPC boundary.
//
// Differences from the Claude client:
// * no built-in web search (unless the chosen model has it, e.g. groq/compound);
// * images only work with a vision-capable model;
// * PDFs are not supported by the API and are refused with a clear message.

use serde_json::{json, Value};

use crate::claude::{base64_for, Chat, ChatContext, ChatReply, MAX_INLINE_TEXT};
use crate::secrets;

const ENDPOINT: &str = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TOKENS: u32 = 4096;

/// Default model. Groq's catalogue changes often; the settings window lets the
/// user type any model id from https://console.groq.com/docs/models.
pub const DEFAULT_MODEL: &str = "openai/gpt-oss-120b";

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You can help with absolutely anything — coding, questions, writing, explanations. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

/// One chat turn against Groq. Same contract as `claude::send`.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
    brain: Option<&str>,
) -> Result<ChatReply, String> {
    let key = secrets::get("groq-api-key")
        .ok_or_else(|| "Groq API key missing. Open settings.".to_string())?;

    let mut text_parts: Vec<String> = Vec::new();
    let mut image: Option<Value> = None;

    // File / window context rides along with the first message only.
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                match file_part(path)? {
                    FilePart::Text(t) => text_parts.push(t),
                    FilePart::Image(v) => image = Some(v),
                    FilePart::Skipped => {}
                }
                text_parts.push(format!("File: {name}"));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                text_parts.push(text);
            }
            None => {}
        }
    }
    text_parts.push(query);
    let text = text_parts.join("\n\n");

    let content = match image {
        Some(img) => json!([{ "type": "text", "text": text }, img]),
        None => Value::String(text),
    };
    chat.push(json!({ "role": "user", "content": content }));

    let system = format!("{SYSTEM_PROMPT}{}", brain.unwrap_or(""));
    let mut messages = vec![json!({ "role": "system", "content": system })];
    messages.extend(chat.snapshot());

    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": messages,
    });

    let response = match call(&key, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop(); // keep the history consistent with what the model saw
            return Err(err);
        }
    };

    let answer = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if answer.is_empty() {
        chat.pop();
        return Err("No response text.".into());
    }

    chat.push(json!({ "role": "assistant", "content": answer.clone() }));
    Ok(ChatReply { text: answer, sources: Vec::new() })
}

pub(crate) async fn call(key: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(ENDPOINT)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("Groq API {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

enum FilePart {
    Text(String),
    Image(Value),
    Skipped,
}

/// Image → image_url part (data URL), text/code → inline text, PDF → refused.
fn file_part(path: &str) -> Result<FilePart, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media = match ext.as_str() {
        "pdf" => {
            return Err(
                "Groq can't read PDFs. Switch the chat to Claude in Settings, or save the PDF as text."
                    .into(),
            )
        }
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };

    if let Some(media) = media {
        let bytes = std::fs::read(path).map_err(|e| format!("cannot read file: {e}"))?;
        let url = format!("data:{media};base64,{}", base64_for(&bytes));
        return Ok(FilePart::Image(json!({ "type": "image_url", "image_url": { "url": url } })));
    }

    let Ok(meta) = std::fs::metadata(path) else { return Ok(FilePart::Skipped) };
    if meta.len() > MAX_INLINE_TEXT {
        return Ok(FilePart::Skipped);
    }
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(FilePart::Text(format!("File contents:\n{text}"))),
        Err(_) => Ok(FilePart::Skipped),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdfs_are_refused_with_a_message() {
        assert!(file_part("C:/x/report.pdf").is_err());
    }

    #[test]
    fn missing_text_files_are_skipped_not_fatal() {
        assert!(matches!(file_part("C:/does/not/exist.txt"), Ok(FilePart::Skipped)));
    }
}
