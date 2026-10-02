// Second brain — quick notes that become an Obsidian vault.
//
// "Fechei o chamado 4521 da Acme, era timeout na integração de pagamentos"
//   → Groq classifies it (area, type, title, people/clients/systems, a date if
//     there is one) as JSON;
//   → it is written as Markdown into the vault: the note in Área/Tipo/, one note
//     per entity under Entidades/ (so the graph connects), a line in the day's
//     note under Diário/, and a CLAUDE.md that explains the layout to Claude.
//
// Every path is built from cleaned names and checked to stay inside the vault.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

pub const AREAS: [&str; 3] = ["Trabalho", "TCC", "Pessoal"];

/// (type id, folder) — the types the AI may pick.
const TYPES: [(&str, &str); 8] = [
    ("chamado", "Chamados"),
    ("regra", "Regras"),
    ("decisao", "Decisões"),
    ("reuniao", "Reuniões"),
    ("estudo", "Estudos"),
    ("ideia", "Ideias"),
    ("lembrete", "Lembretes"),
    ("nota", "Notas"),
];

/// (entity kind, folder under Entidades/)
const ENTITY_KINDS: [(&str, &str); 5] = [
    ("cliente", "Clientes"),
    ("sistema", "Sistemas"),
    ("pessoa", "Pessoas"),
    ("projeto", "Projetos"),
    ("assunto", "Assuntos"),
];

/// The PC's local date and time, sent by the island (Rust has no time zones here).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Now {
    pub date: String,    // 2026-10-01
    pub time: String,    // 14:32
    pub weekday: String, // quinta-feira
}

/// What one save wrote, so it can be undone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub path: String,
    pub relative: String,
    pub created: Vec<String>,
    pub daily_path: String,
    pub daily_line: String,
}

pub fn default_vault() -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    Path::new(&home)
        .join("Documents")
        .join("Obsidian")
        .join("Segundo Cérebro")
        .to_string_lossy()
        .to_string()
}

fn vault_path(vault: &str) -> Result<PathBuf, String> {
    let v = vault.trim();
    if v.is_empty() {
        return Err("Escolha a pasta do cofre em Settings → Notes.".into());
    }
    Ok(PathBuf::from(v))
}

/// A name that is safe as a file name and as an Obsidian link.
fn clean_name(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if "\\/:*?\"<>|#^[]".contains(c) || c.is_control() {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c == ' ');
    let short: String = trimmed.chars().take(80).collect();
    if short.is_empty() { "Sem título".into() } else { short }
}

fn folder_for_type(kind: &str) -> &'static str {
    TYPES.iter().find(|(id, _)| *id == kind).map(|(_, f)| *f).unwrap_or("Notas")
}

fn folder_for_entity(kind: &str) -> &'static str {
    ENTITY_KINDS.iter().find(|(id, _)| *id == kind).map(|(_, f)| *f).unwrap_or("Assuntos")
}

/// Entity notes already in the vault, so the AI reuses their exact names.
fn existing_entities(vault: &Path) -> Vec<String> {
    let mut names = Vec::new();
    for (kind, folder) in ENTITY_KINDS {
        let dir = vault.join("Entidades").join(folder);
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("md") {
                    if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                        names.push(format!("{stem} ({kind})"));
                    }
                }
                if names.len() >= 300 {
                    return names;
                }
            }
        }
    }
    names
}

// ── Classify ──────────────────────────────────────────────────────────────────

pub async fn classify(vault: &str, model: &str, text: String, now: &Now) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Escreva algo para anotar.".into());
    }
    let key = secrets::get("groq-api-key")
        .ok_or_else(|| "Chave do Groq ausente. Abra Settings → Groq.".to_string())?;
    let known = vault_path(vault).map(|v| existing_entities(&v)).unwrap_or_default();

    let system = format!(
        "Você organiza anotações rápidas de uma pessoa num cofre do Obsidian. \
Hoje é {weekday}, {date}, {time}. \
Responda APENAS com um objeto JSON, sem texto fora dele, com estes campos:\n\
- \"area\": \"Trabalho\", \"TCC\" ou \"Pessoal\". TCC é o trabalho de conclusão de curso (orientador, capítulos, metodologia, banca). Trabalho é o emprego (chamados, clientes, sistemas, regras de negócio). O resto é Pessoal.\n\
- \"tipo\": um de chamado, regra, decisao, reuniao, estudo, ideia, lembrete, nota.\n\
- \"titulo\": título curto e claro, até 60 caracteres, sem data (ex.: \"Chamado 4521 — timeout na integração de pagamentos\").\n\
- \"resumo\": o registro reescrito em Markdown claro e completo, em português, sem inventar fatos. Coloque cada entidade entre [[ ]] exatamente com o nome usado em \"entidades\".\n\
- \"entidades\": lista de {{\"nome\", \"tipo\"}} com tipo em cliente, sistema, pessoa, projeto, assunto. Só entidades citadas. Se uma já existir na lista abaixo, use exatamente o mesmo nome.\n\
- \"tags\": até 5 palavras-chave em minúsculas, sem #.\n\
- \"chamado\": o número do chamado/ticket, se houver, senão null.\n\
- \"lembrete\": se houver algo para fazer numa data (prazo, reunião, compromisso), {{\"titulo\", \"data\": \"AAAA-MM-DD\", \"hora\": \"HH:MM\" ou null, \"duracao_min\": número ou null}}, resolvendo datas relativas (amanhã, sexta, dia 10) a partir de hoje; senão null.\n\
Entidades já existentes no cofre: {known}",
        weekday = now.weekday,
        date = now.date,
        time = now.time,
        known = if known.is_empty() { "nenhuma ainda".to_string() } else { known.join(", ") },
    );

    let body = json!({
        "model": model,
        "max_tokens": 2048,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text },
        ],
    });
    let response = crate::groq::call(&key, &body).await?;
    let content = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or("A IA não respondeu.")?;
    let raw: Value = serde_json::from_str(content.trim())
        .map_err(|_| "A IA respondeu num formato inesperado. Tente de novo.".to_string())?;
    Ok(normalise(raw, &text))
}

/// Keeps only what the writer understands, with safe defaults.
fn normalise(raw: Value, original: &str) -> Value {
    let s = |k: &str| raw.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();

    let mut area = s("area");
    if !AREAS.contains(&area.as_str()) {
        area = "Pessoal".into();
    }
    let mut kind = s("tipo").to_lowercase().replace('ã', "a").replace('ç', "c").replace('õ', "o");
    if !TYPES.iter().any(|(id, _)| *id == kind) {
        kind = "nota".into();
    }
    let mut title = s("titulo");
    if title.is_empty() {
        title = original.chars().take(60).collect();
    }
    let mut summary = s("resumo");
    if summary.is_empty() {
        summary = original.to_string();
    }

    let entities: Vec<Value> = raw
        .get("entidades")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    let name = clean_name(e.get("nome")?.as_str()?);
                    let mut k = e.get("tipo").and_then(Value::as_str).unwrap_or("assunto").to_lowercase();
                    if !ENTITY_KINDS.iter().any(|(id, _)| *id == k) {
                        k = "assunto".into();
                    }
                    (name != "Sem título").then(|| json!({ "nome": name, "tipo": k }))
                })
                .take(12)
                .collect()
        })
        .unwrap_or_default();

    let tags: Vec<String> = raw
        .get("tags")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|t| t.trim().trim_start_matches('#').to_lowercase().replace(' ', "-"))
                .filter(|t| !t.is_empty())
                .take(5)
                .collect()
        })
        .unwrap_or_default();

    let ticket = raw.get("chamado").and_then(|v| match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    });

    let reminder = raw.get("lembrete").and_then(|r| {
        let date = r.get("data")?.as_str()?.trim().to_string();
        let ok = date.len() == 10 && date.as_bytes()[4] == b'-' && date.as_bytes()[7] == b'-';
        if !ok {
            return None;
        }
        let time = r.get("hora").and_then(Value::as_str).map(str::trim).filter(|t| {
            t.len() == 5 && t.as_bytes()[2] == b':'
        });
        Some(json!({
            "titulo": r.get("titulo").and_then(Value::as_str).unwrap_or(&title),
            "data": date,
            "hora": time,
            "duracaoMin": r.get("duracao_min").and_then(Value::as_u64).unwrap_or(60),
        }))
    });

    json!({
        "area": area,
        "tipo": kind,
        "titulo": clean_name(&title),
        "resumo": summary,
        "entidades": entities,
        "tags": tags,
        "chamado": ticket,
        "lembrete": reminder,
    })
}

// ── Write ─────────────────────────────────────────────────────────────────────

const CLAUDE_MD: &str = "# Como este cofre é organizado\n\n\
Este é um \"segundo cérebro\" alimentado pelo Coucou. Cada registro rápido vira uma nota.\n\n\
- `Trabalho/`, `TCC/`, `Pessoal/` — uma pasta por área, com subpastas por tipo: \
Chamados, Regras, Decisões, Reuniões, Estudos, Ideias, Lembretes, Notas.\n\
- `Entidades/` — uma nota por cliente, sistema, pessoa, projeto ou assunto. As notas \
de registro apontam para elas com [[links]], e o Obsidian mostra as ligações (backlinks e Graph View).\n\
- `Diário/AAAA-MM-DD.md` — tudo o que foi registrado em cada dia, em ordem.\n\n\
Cada nota começa com propriedades (frontmatter): `area`, `tipo`, `data`, `hora`, `tags` e, \
quando houver, `chamado`. Para responder perguntas, procure pelas propriedades e siga os links \
para as entidades. O texto original do registro está no fim de cada nota.\n";

/// Fails unless `path` is inside `vault` (no "..", no other drive).
fn inside(vault: &Path, path: &Path) -> bool {
    let (Ok(v), Ok(p)) = (std::fs::canonicalize(vault), std::fs::canonicalize(path)) else {
        return false;
    };
    p.starts_with(&v)
}

fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.md"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let p = dir.join(format!("{stem} ({n}).md"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem} ({}).md", std::process::id()))
}

fn yaml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn write(
    vault: &str,
    plan: &Value,
    original: &str,
    now: &Now,
    calendar_url: Option<&str>,
) -> Result<Written, String> {
    let vault = vault_path(vault)?;
    std::fs::create_dir_all(&vault).map_err(|e| format!("Não consegui criar o cofre: {e}"))?;
    let claude_md = vault.join("CLAUDE.md");
    if !claude_md.exists() {
        let _ = std::fs::write(&claude_md, CLAUDE_MD);
    }

    let get = |k: &str| plan.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let area = {
        let a = get("area");
        if AREAS.contains(&a.as_str()) { a } else { "Pessoal".to_string() }
    };
    let kind = get("tipo");
    let title = clean_name(&get("titulo"));
    let summary = get("resumo");
    let ticket = plan.get("chamado").and_then(Value::as_str).map(str::to_string);
    let tags: Vec<String> = plan
        .get("tags")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let entities: Vec<(String, String)> = plan
        .get("entidades")
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .filter_map(|e| {
                    Some((
                        clean_name(e.get("nome")?.as_str()?),
                        e.get("tipo").and_then(Value::as_str).unwrap_or("assunto").to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut created: Vec<String> = Vec::new();

    // The note itself. Dated types carry the day in the file name.
    let dir = vault.join(&area).join(folder_for_type(&kind));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dated = matches!(kind.as_str(), "chamado" | "decisao" | "reuniao" | "lembrete" | "nota");
    let stem = if dated { format!("{} {}", now.date, title) } else { title.clone() };
    let note_path = unique_path(&dir, &clean_name(&stem));
    let note_stem = note_path.file_stem().and_then(|s| s.to_str()).unwrap_or("nota").to_string();

    let mut md = String::from("---\n");
    md.push_str(&format!("area: {area}\ntipo: {kind}\ndata: {}\nhora: {}\n", now.date, yaml_str(&now.time)));
    if let Some(t) = &ticket {
        md.push_str(&format!("chamado: {}\n", yaml_str(t)));
    }
    let mut all_tags = vec![area.to_lowercase(), kind.clone()];
    all_tags.extend(tags.iter().cloned());
    let mut seen = std::collections::HashSet::new();
    all_tags.retain(|t| seen.insert(t.clone()));
    md.push_str(&format!(
        "tags: [{}]\n",
        all_tags.iter().map(|t| yaml_str(t)).collect::<Vec<_>>().join(", ")
    ));
    let mut has_due = false;
    if let Some(r) = plan.get("lembrete").filter(|r| r.is_object()) {
        if let Some(d) = r.get("data").and_then(Value::as_str) {
            md.push_str(&format!("prazo: {d}\n"));
            has_due = true;
        }
    }
    // A reminder without a date still belongs on the to-do list ("Meu dia").
    if kind == "lembrete" && !has_due {
        md.push_str("pendente: true\n");
    }
    md.push_str("---\n\n");
    md.push_str(&format!("# {title}\n\n{}\n", summary.trim()));
    // A note with a date carries its Google Calendar event, one tap to confirm
    // (on the phone too).
    if let Some(url) = calendar_url.filter(|u| u.starts_with("https://calendar.google.com/")) {
        md.push_str(&format!("\n[➕ Adicionar ao Google Agenda]({url})\n"));
    }
    if !entities.is_empty() {
        md.push_str("\n## Relacionado\n\n");
        for (name, k) in &entities {
            md.push_str(&format!("- {}: [[{name}]]\n", capitalise(k)));
        }
    }
    md.push_str(&format!(
        "\n---\n> Registro original ({} {}): {}\n",
        now.date,
        now.time,
        original.trim().replace('\n', "\n> ")
    ));
    std::fs::write(&note_path, md).map_err(|e| format!("Não consegui salvar a nota: {e}"))?;
    created.push(note_path.to_string_lossy().to_string());

    // One note per entity, created on first mention, so the graph links up.
    for (name, k) in &entities {
        let edir = vault.join("Entidades").join(folder_for_entity(k));
        if std::fs::create_dir_all(&edir).is_err() {
            continue;
        }
        let epath = edir.join(format!("{name}.md"));
        if !epath.exists() {
            let body = format!("---\ntipo: {k}\n---\n\n# {name}\n\nCriada pelo Coucou. As notas que citam esta página aparecem nos backlinks.\n");
            if std::fs::write(&epath, body).is_ok() {
                created.push(epath.to_string_lossy().to_string());
            }
        }
    }

    // The day's note.
    let ddir = vault.join("Diário");
    std::fs::create_dir_all(&ddir).map_err(|e| e.to_string())?;
    let daily = ddir.join(format!("{}.md", now.date));
    if !daily.exists() {
        std::fs::write(&daily, format!("# {} ({})\n\n", now.date, now.weekday)).map_err(|e| e.to_string())?;
        created.push(daily.to_string_lossy().to_string());
    }
    let line = format!("- {} [[{note_stem}]] · {area} · {kind}\n", now.time);
    let mut current = std::fs::read_to_string(&daily).unwrap_or_default();
    if !current.ends_with('\n') && !current.is_empty() {
        current.push('\n');
    }
    current.push_str(&line);
    std::fs::write(&daily, current).map_err(|e| e.to_string())?;

    let relative = note_path
        .strip_prefix(&vault)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| note_stem.clone());

    Ok(Written {
        path: note_path.to_string_lossy().to_string(),
        relative,
        created,
        daily_path: daily.to_string_lossy().to_string(),
        daily_line: line,
    })
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Removes what one save created and its line in the day's note.
pub fn undo(vault: &str, written: &Written) -> Result<(), String> {
    let vault = vault_path(vault)?;
    let daily = PathBuf::from(&written.daily_path);
    if inside(&vault, &daily) {
        if let Ok(text) = std::fs::read_to_string(&daily) {
            let _ = std::fs::write(&daily, text.replacen(&written.daily_line, "", 1));
        }
    }
    for p in &written.created {
        let path = PathBuf::from(p);
        if path.extension().and_then(|x| x.to_str()) == Some("md") && inside(&vault, &path) {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// obsidian://open?path=… — Obsidian opens the note (the vault must be open once).
pub fn open_in_obsidian(path: &str) -> bool {
    let mut encoded = String::new();
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => encoded.push(b as char),
            _ => encoded.push_str(&format!("%{b:02X}")),
        }
    }
    std::process::Command::new("explorer.exe")
        .arg(format!("obsidian://open?path={encoded}"))
        .spawn()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe() {
        assert_eq!(clean_name("a/b\\c:d*e?f\"g<h>i|j#k^l[m]n"), "a b c d e f g h i j k l m n");
        assert_eq!(clean_name("  ..  "), "Sem título");
        assert_eq!(clean_name("Chamado 4521 — timeout"), "Chamado 4521 — timeout");
    }

    #[test]
    fn normalise_fills_defaults() {
        let v = normalise(json!({ "area": "X", "tipo": "Decisão" }), "texto original");
        assert_eq!(v["area"], "Pessoal");
        assert_eq!(v["tipo"], "decisao");
        assert_eq!(v["titulo"], "texto original");
        assert!(v["lembrete"].is_null());
    }
}
