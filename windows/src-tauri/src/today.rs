// "Meu dia" — what is due, and the daily stand-up written for you.
//
// Pending items come from the Obsidian vault:
// * notes with `prazo: AAAA-MM-DD` or `pendente: true` in their properties,
//   until `feito: true` is added (the ✓ button does that);
// * unchecked Markdown tasks `- [ ] …` anywhere, with an optional due date
//   written as `📅 AAAA-MM-DD` (the Obsidian Tasks format).
//
// The daily reads the day notes, the notes written, the Claude Code activity
// (logged by the island in %LOCALAPPDATA%\Coucou\activity\) and what is due,
// and Groq writes the stand-up text. Nothing is posted anywhere.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{secrets, settings};

const MAX_FILES: usize = 3000;
const MAX_FILE_BYTES: u64 = 200_000;
const MAX_ITEMS: usize = 80;

// ── Activity log ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    pub time: String,
    pub project: String,
    pub kind: String,
    pub text: String,
}

fn activity_dir() -> PathBuf {
    settings::local_dir().join("activity")
}

fn valid_date(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && d.chars().filter(|c| c.is_ascii_digit()).count() == 8
}

pub fn activity_append(date: &str, entry: &Activity) -> Result<(), String> {
    if !valid_date(date) {
        return Err("bad date".into());
    }
    let dir = activity_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{date}.jsonl")))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    sweep_activity(&dir);
    Ok(())
}

/// Keeps 60 days of activity.
fn sweep_activity(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    files.sort();
    if files.len() > 60 {
        for old in &files[..files.len() - 60] {
            let _ = std::fs::remove_file(old);
        }
    }
}

fn activity_for(date: &str) -> Vec<Activity> {
    if !valid_date(date) {
        return Vec::new();
    }
    std::fs::read_to_string(activity_dir().join(format!("{date}.jsonl")))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

// ── Pending items ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    /// "note" (a note with prazo/pendente) or "task" (a `- [ ]` line).
    pub kind: String,
    pub title: String,
    pub path: String,
    /// 0-based line of a `- [ ]` task; 0 for notes.
    pub line: usize,
    /// The exact line text, checked again before ticking it.
    pub text: String,
    pub due: Option<String>,
    pub area: Option<String>,
}

fn markdown_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
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

/// The front matter's `key: value` pairs (flat, as the Coucou writes them).
fn front_matter(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(rest) = text.strip_prefix("---") else { return out };
    let Some(end) = rest.find("\n---") else { return out };
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            out.push((k.trim().to_string(), v.trim().trim_matches('"').to_string()));
        }
    }
    out
}

fn heading(text: &str, fallback: &str) -> String {
    text.lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// A `📅 AAAA-MM-DD` due date inside a task line.
fn task_due(line: &str) -> Option<String> {
    let i = line.find('📅')?;
    let rest = line[i + '📅'.len_utf8()..].trim_start();
    let d: String = rest.chars().take(10).collect();
    valid_date(&d).then_some(d)
}

pub fn pending(vault: &str) -> Vec<Pending> {
    let root = PathBuf::from(vault.trim());
    if vault.trim().is_empty() || !root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for p in markdown_files(&root) {
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("nota").to_string();
        let path = p.to_string_lossy().to_string();

        let fm = front_matter(&text);
        let get = |k: &str| fm.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        let done = get("feito").map(|v| v == "true").unwrap_or(false);
        let due = get("prazo").filter(|d| valid_date(d));
        let flagged = get("pendente").map(|v| v == "true").unwrap_or(false);
        if !done && (due.is_some() || flagged) {
            out.push(Pending {
                kind: "note".into(),
                title: heading(&text, &stem),
                path: path.clone(),
                line: 0,
                text: String::new(),
                due,
                area: get("area"),
            });
        }

        let area = get("area");
        for (i, line) in text.lines().enumerate() {
            let t = line.trim_start();
            if let Some(rest) = t.strip_prefix("- [ ] ").or_else(|| t.strip_prefix("* [ ] ")) {
                let title: String = rest.split('📅').next().unwrap_or(rest).trim().chars().take(140).collect();
                if title.is_empty() {
                    continue;
                }
                out.push(Pending {
                    kind: "task".into(),
                    title,
                    path: path.clone(),
                    line: i,
                    text: line.to_string(),
                    due: task_due(line),
                    area: area.clone(),
                });
            }
        }
        if out.len() >= MAX_ITEMS * 3 {
            break;
        }
    }
    // Dated first (soonest first), then undated.
    out.sort_by(|a, b| match (&a.due, &b.due) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.title.cmp(&b.title),
    });
    out.truncate(MAX_ITEMS);
    out
}

fn inside(vault: &Path, path: &Path) -> bool {
    match (std::fs::canonicalize(vault), std::fs::canonicalize(path)) {
        (Ok(v), Ok(p)) => p.starts_with(v),
        _ => false,
    }
}

/// ✓ — ticks a `- [ ]` line, or adds `feito: true` to a note's properties.
pub fn mark_done(vault: &str, item: &Pending) -> Result<(), String> {
    let root = PathBuf::from(vault.trim());
    let path = PathBuf::from(&item.path);
    if !inside(&root, &path) {
        return Err("Fora do cofre.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let new_text = if item.kind == "task" {
        let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
        let Some(current) = lines.get(item.line) else { return Err("A tarefa mudou de lugar.".into()) };
        if current != &item.text {
            return Err("A nota foi editada; atualize a lista.".into());
        }
        let ticked = current.replacen("[ ]", "[x]", 1);
        lines[item.line] = ticked;
        let mut joined = lines.join("\n");
        if text.ends_with('\n') {
            joined.push('\n');
        }
        joined
    } else if let Some(rest) = text.strip_prefix("---") {
        match rest.find("\n---") {
            Some(end) => format!("---{}\nfeito: true{}", &rest[..end], &rest[end..]),
            None => return Err("Propriedades da nota ilegíveis.".into()),
        }
    } else {
        format!("---\nfeito: true\n---\n\n{text}")
    };
    std::fs::write(&path, new_text).map_err(|e| e.to_string())
}

// ── Daily ─────────────────────────────────────────────────────────────────────

fn body_only(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            return rest[end + 4..].trim_start();
        }
    }
    text
}

fn cap(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

/// `dates`: the days the daily covers (previous workday and today).
/// `today_label`: e.g. "quinta-feira, 01/10". `calendar`: today's events, one per line.
pub async fn generate(
    vault: &str,
    model: &str,
    dates: &[String],
    today_label: &str,
    calendar: &str,
) -> Result<String, String> {
    let key = secrets::get("groq-api-key")
        .ok_or_else(|| "Chave do Groq ausente. Abra Settings → Groq.".to_string())?;
    let root = PathBuf::from(vault.trim());
    let has_vault = !vault.trim().is_empty() && root.is_dir();

    let mut material = String::new();
    for d in dates.iter().filter(|d| valid_date(d)) {
        material.push_str(&format!("\n## Dia {d}\n"));
        if has_vault {
            if let Ok(t) = std::fs::read_to_string(root.join("Diário").join(format!("{d}.md"))) {
                material.push_str(&format!("### Diário\n{}\n", cap(t.trim(), 3000)));
            }
        }
        let acts = activity_for(d);
        if !acts.is_empty() {
            material.push_str("### Claude Code\n");
            for a in acts.iter().take(60) {
                material.push_str(&format!("- {} [{}] {}: {}\n", a.time, a.project, a.kind, cap(&a.text, 160)));
            }
        }
    }
    // Notes written on those days (their summaries, not just titles).
    if has_vault {
        let mut notes = String::new();
        for p in markdown_files(&root) {
            if notes.len() > 20_000 {
                break;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let fm = front_matter(&text);
            let date = fm.iter().find(|(k, _)| k == "data").map(|(_, v)| v.as_str()).unwrap_or("");
            if dates.iter().any(|d| d == date) {
                let area = fm.iter().find(|(k, _)| k == "area").map(|(_, v)| v.as_str()).unwrap_or("");
                notes.push_str(&format!("\n#### ({date}, {area}) {}\n", cap(body_only(&text).trim(), 700)));
            }
        }
        if !notes.is_empty() {
            material.push_str(&format!("\n## Notas registradas\n{notes}\n"));
        }
    }
    let due: Vec<Pending> = if has_vault { pending(vault) } else { Vec::new() };
    if !due.is_empty() {
        material.push_str("\n## Pendências abertas\n");
        for p in due.iter().take(30) {
            material.push_str(&format!(
                "- {}{}{}\n",
                p.title,
                p.due.as_ref().map(|d| format!(" (prazo {d})")).unwrap_or_default(),
                p.area.as_ref().map(|a| format!(" [{a}]")).unwrap_or_default()
            ));
        }
    }
    if !calendar.trim().is_empty() {
        material.push_str(&format!("\n## Agenda de hoje\n{}\n", cap(calendar.trim(), 2000)));
    }
    if material.trim().is_empty() {
        return Err("Não há registros desses dias ainda: anote algo (Ctrl+Alt+N) ou use o Claude Code.".into());
    }

    let system = format!(
        "Você escreve a daily (stand-up) de uma pessoa a partir dos registros dela. Hoje é {today_label}. \
Escreva em português, pronta para colar no Slack ou Teams, com exatamente estas três partes:\n\
*O que fiz:* tópicos curtos com o que foi feito no dia anterior e hoje até agora (chamados resolvidos, \
decisões, entregas, tarefas concluídas com o Claude Code, agrupadas por projeto quando fizer sentido).\n\
*O que vou fazer:* tópicos com as pendências de hoje e atrasadas, e as reuniões da agenda.\n\
*Impedimentos:* bloqueios ou dependências citados nos registros; se não houver, escreva \"Nenhum\".\n\
Foque no trabalho; deixe de fora assuntos pessoais e do TCC, a menos que afetem o trabalho. \
Use só fatos dos registros, sem inventar. Seja direto, sem introdução nem despedida."
    );
    let body = json!({
        "model": model,
        "max_tokens": 1500,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": format!("Registros:\n{material}") },
        ],
    });
    let response = crate::groq::call(&key, &body).await?;
    response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "A IA não respondeu.".to_string())
}

/// Saves the daily as Trabalho/Dailies/AAAA-MM-DD Daily.md. Returns its path.
pub fn save(vault: &str, date: &str, text: &str) -> Result<String, String> {
    if !valid_date(date) {
        return Err("bad date".into());
    }
    let root = PathBuf::from(vault.trim());
    if vault.trim().is_empty() {
        return Err("Escolha a pasta do cofre em Settings → Notes.".into());
    }
    let dir = root.join("Trabalho").join("Dailies");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{date} Daily.md"));
    let md = format!("---\narea: Trabalho\ntipo: daily\ndata: {date}\ntags: [\"trabalho\", \"daily\"]\n---\n\n# Daily {date}\n\n{}\n", text.trim());
    std::fs::write(&path, md).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_dates_in_tasks() {
        assert_eq!(task_due("- [ ] pagar boleto 📅 2026-10-10"), Some("2026-10-10".into()));
        assert_eq!(task_due("- [ ] sem data"), None);
    }

    #[test]
    fn front_matter_pairs() {
        let fm = front_matter("---\narea: TCC\nprazo: 2026-10-08\n---\n\n# T");
        assert!(fm.contains(&("prazo".into(), "2026-10-08".into())));
    }
}
