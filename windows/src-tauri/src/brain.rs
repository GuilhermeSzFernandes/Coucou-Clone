// The chat that knows you — reads the Obsidian vault before answering.
//
// Each chat turn gets, in its system prompt:
// * the profile: "Perfil.md" (written by you, never touched) and
//   "Perfil (gerado).md" (written by the AI from your notes, on request);
// * the last 7 days of Diário/;
// * the notes that best match the question (plain keyword scoring over titles
//   and text, newer notes slightly ahead) — capped so the prompt stays small.
//
// Everything is read locally; only the selected excerpts go to the AI.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

const MAX_FILES: usize = 3000;
const MAX_FILE_BYTES: u64 = 200_000;
const TOP_NOTES: usize = 6;
const NOTE_CHARS: usize = 1400;
const PROFILE_CHARS: usize = 5000;
const DIARY_CHARS: usize = 3000;

pub const PROFILE_MANUAL: &str = "Perfil.md";
pub const PROFILE_AUTO: &str = "Perfil (gerado).md";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub title: String,
    pub path: String,
}

pub struct Context {
    pub text: String,
    pub sources: Vec<Source>,
}

const STOPWORDS: &[&str] = &[
    "que", "para", "com", "uma", "por", "como", "mais", "mas", "dos", "das", "nos", "nas", "foi",
    "ser", "tem", "sao", "esta", "isso", "isto", "ele", "ela", "eles", "elas", "voce", "meu",
    "minha", "meus", "minhas", "seu", "sua", "qual", "quais", "quando", "onde", "quem", "sobre",
    "fiz", "fazer", "feito", "tenho", "teve", "ter", "pelo", "pela", "entre", "ate", "aos",
    "the", "and", "for", "what", "this", "that", "with", "from",
];

/// Lowercase without accents, so "Decisão" and "decisao" match.
fn fold(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'a',
            'é' | 'ê' | 'è' | 'ë' | 'É' | 'Ê' | 'È' | 'Ë' => 'e',
            'í' | 'î' | 'ì' | 'ï' | 'Í' | 'Î' | 'Ì' | 'Ï' => 'i',
            'ó' | 'ô' | 'õ' | 'ò' | 'ö' | 'Ó' | 'Ô' | 'Õ' | 'Ò' | 'Ö' => 'o',
            'ú' | 'û' | 'ù' | 'ü' | 'Ú' | 'Û' | 'Ù' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            other => other.to_ascii_lowercase(),
        })
        .collect()
}

fn terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = fold(query)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3 || t.chars().all(|c| c.is_ascii_digit()) && !t.is_empty())
        .filter(|t| !STOPWORDS.contains(t))
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out.truncate(12);
    out
}

fn count(hay: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    hay.matches(needle).count()
}

fn markdown_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // .obsidian, .trash
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|x| x.to_str()) == Some("md") {
                out.push(p);
                if out.len() >= MAX_FILES {
                    return out;
                }
            }
        }
    }
    out
}

fn read_capped(path: &Path, chars: usize) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(cap(&text, chars))
}

fn cap(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        text.to_string()
    } else {
        let cut: String = text.chars().take(chars).collect();
        format!("{cut}\n[…]")
    }
}

fn stem(path: &Path) -> String {
    path.file_stem().and_then(|s| s.to_str()).unwrap_or("nota").to_string()
}

fn is_recent(path: &Path, days: u64) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|age| age < Duration::from_secs(days * 86_400))
        .unwrap_or(false)
}

/// What the chat should know for this question. None when the vault is not set.
pub fn context_for(vault: &str, query: &str) -> Option<Context> {
    let root = PathBuf::from(vault.trim());
    if vault.trim().is_empty() || !root.is_dir() {
        return None;
    }
    let mut text = String::from(
        "\n\n## O que você sabe sobre o usuário\n\
O usuário mantém um \"segundo cérebro\" no Obsidian. Abaixo estão o perfil dele, o diário recente e as notas \
mais relacionadas à pergunta. Use isso para personalizar a resposta e para responder sobre o que ele registrou. \
Quando usar uma nota, cite o título entre [[ ]]. Se a resposta não estiver nas notas, diga que não encontrou \
registro sobre isso, em vez de inventar. Não repita o perfil de volta para ele sem necessidade.\n",
    );
    let mut sources: Vec<Source> = Vec::new();

    // Profile
    for name in [PROFILE_MANUAL, PROFILE_AUTO] {
        let p = root.join(name);
        if let Some(body) = read_capped(&p, PROFILE_CHARS) {
            text.push_str(&format!("\n### {}\n{}\n", stem(&p), body.trim()));
        }
    }

    // Recent diary
    let diary = root.join("Diário");
    if let Ok(entries) = std::fs::read_dir(&diary) {
        let mut days: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
            .collect();
        days.sort();
        days.reverse();
        let mut chunk = String::new();
        for d in days.into_iter().take(7) {
            if let Ok(t) = std::fs::read_to_string(&d) {
                chunk.push_str(t.trim());
                chunk.push_str("\n\n");
            }
        }
        if !chunk.is_empty() {
            text.push_str(&format!("\n### Diário (últimos 7 dias)\n{}\n", cap(&chunk, DIARY_CHARS).trim()));
        }
    }

    // Notes matching the question
    let wanted = terms(query);
    if !wanted.is_empty() {
        let mut scored: Vec<(f64, PathBuf, String)> = Vec::new();
        for p in markdown_files(&root) {
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name == PROFILE_MANUAL || name == PROFILE_AUTO || name == "CLAUDE.md" {
                continue;
            }
            if p.starts_with(&diary) {
                continue; // already included above
            }
            let Some(body) = read_capped(&p, 20_000) else { continue };
            let title = fold(&stem(&p));
            let folded = fold(&body);
            let mut score = 0.0;
            for t in &wanted {
                score += (count(&title, t) * 5) as f64 + count(&folded, t).min(10) as f64;
            }
            if score <= 0.0 {
                continue;
            }
            if is_recent(&p, 30) {
                score *= 1.3;
            }
            scored.push((score, p, body));
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        if !scored.is_empty() {
            text.push_str("\n### Notas relacionadas à pergunta\n");
        }
        for (_, p, body) in scored.into_iter().take(TOP_NOTES) {
            let title = stem(&p);
            let rel = p.strip_prefix(&root).map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
            text.push_str(&format!("\n#### [[{title}]] ({rel})\n{}\n", cap(&body, NOTE_CHARS).trim()));
            sources.push(Source { title, path: p.to_string_lossy().to_string() });
        }
    }

    Some(Context { text, sources })
}

/// Front matter removed, for the profile digest.
fn body_only(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            return rest[end + 4..].trim_start();
        }
    }
    text
}

/// Rewrites "Perfil (gerado).md" from the most recent notes. Returns its path.
pub async fn refresh_profile(vault: &str, model: &str, date: &str) -> Result<String, String> {
    let root = PathBuf::from(vault.trim());
    if vault.trim().is_empty() || !root.is_dir() {
        return Err("Escolha a pasta do cofre em Settings → Notes.".into());
    }
    let key = secrets::get("groq-api-key")
        .ok_or_else(|| "Chave do Groq ausente. Abra Settings → Groq.".to_string())?;

    let skip = [root.join("Diário"), root.join("Entidades")];
    let mut notes: Vec<(SystemTime, PathBuf)> = markdown_files(&root)
        .into_iter()
        .filter(|p| !skip.iter().any(|s| p.starts_with(s)))
        .filter(|p| {
            let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            n != PROFILE_AUTO && n != "CLAUDE.md"
        })
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    if notes.len() < 3 {
        return Err("Ainda há poucas notas no cofre. Anote mais algumas coisas (Ctrl+Alt+N) e tente de novo.".into());
    }
    notes.sort_by(|a, b| b.0.cmp(&a.0));

    let mut digest = String::new();
    for (_, p) in notes.iter().take(150) {
        let Some(text) = read_capped(p, 4000) else { continue };
        let rel = p.strip_prefix(&root).map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
        digest.push_str(&format!("\n### {rel}\n{}\n", cap(body_only(&text), 450).trim()));
        if digest.len() > 60_000 {
            break;
        }
    }

    let system = "Você escreve o perfil de uma pessoa a partir das anotações pessoais dela, para que um assistente \
de IA a conheça. Escreva em português, em Markdown, com estas seções (omita as vazias): \
## Quem é · ## Trabalho (empresa, função, sistemas, clientes, responsabilidades) · \
## TCC (tema, orientador, fase, prazos) · ## Vida pessoal · ## Pessoas importantes (com [[links]] para os nomes) · \
## Preferências e jeito de trabalhar · ## Pendências e assuntos recorrentes. \
Use somente fatos que aparecem nas notas; não invente nem suponha. Seja conciso: tópicos curtos. \
Responda só com o Markdown do perfil, sem introdução.";
    let body = json!({
        "model": model,
        "max_tokens": 2048,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": format!("Anotações (mais recentes primeiro):\n{digest}") },
        ],
    });
    let response = crate::groq::call(&key, &body).await?;
    let profile = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("A IA não respondeu.")?;

    let path = root.join(PROFILE_AUTO);
    let file = format!(
        "---\ntipo: perfil\natualizado: {date}\n---\n\n# Perfil (gerado)\n\n\
> Escrito pelo Coucou a partir das suas notas em {date}. Este arquivo é reescrito a cada atualização — \
para corrigir ou acrescentar algo de forma permanente, use o **Perfil.md**.\n\n{profile}\n"
    );
    std::fs::write(&path, file).map_err(|e| format!("Não consegui salvar o perfil: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_fold_and_filter() {
        assert_eq!(terms("Quais chamados da Acme tiveram timeout?"), vec!["acme", "chamados", "timeout", "tiveram"]);
        assert_eq!(terms("chamado 4521"), vec!["4521", "chamado"]);
        assert_eq!(fold("Decisão Reunião"), "decisao reuniao");
    }

    #[test]
    fn front_matter_is_skipped() {
        assert_eq!(body_only("---\na: 1\n---\n\n# T\nx"), "# T\nx");
        assert_eq!(body_only("# T"), "# T");
    }
}
