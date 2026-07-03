use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

fn normalize(s: &str) -> String {
    s.to_lowercase()
        .replace('_', " ")
        .replace("  ", " ")
        .trim()
        .to_string()
}

fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    let len1 = s1.len();
    let len2 = s2.len();
    let mut matrix = vec![vec![0; len2 + 1]; len1 + 1];

    for i in 0..=len1 {
        matrix[i][0] = i;
    }
    for j in 0..=len2 {
        matrix[0][j] = j;
    }

    for i in 1..=len1 {
        for j in 1..=len2 {
            let cost = if s1.chars().nth(i - 1) == s2.chars().nth(j - 1) {
                0
            } else {
                1
            };
            matrix[i][j] = *[
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost,
            ]
            .iter()
            .min()
            .unwrap();
        }
    }

    matrix[len1][len2]
}

fn main() {
    let repo_root = env::var("REPO_ROOT").unwrap_or_else(|_| {
        // Try to find repo root by looking for the backend/data/enriched_400.json
        let mut current = env::current_dir().expect("Could not get current dir");
        for _ in 0..10 {
            let enriched = current.join("backend").join("data").join("enriched_400.json");
            if enriched.exists() {
                return current.to_string_lossy().to_string();
            }
            if current.pop() == false {
                break;
            }
        }
        ".".to_string()
    });

    let downloads_dir = PathBuf::from(&repo_root).join("downloads");
    let enriched_path = PathBuf::from(&repo_root)
        .join("backend")
        .join("data")
        .join("enriched_400.json");

    let enriched_data: Value = serde_json::from_str(
        &fs::read_to_string(enriched_path).expect("Failed to read enriched_400.json"),
    )
    .expect("Failed to parse enriched_400.json");

    let items = enriched_data["items"]
        .as_array()
        .expect("items should be an array");

    let mut torrent_map: HashMap<String, String> = HashMap::new();
    let mut matched = 0;
    let mut unmatched = Vec::new();

    if let Ok(entries) = fs::read_dir(downloads_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "torrent") {
                let filename = path.file_stem().unwrap().to_string_lossy().to_string();
                let torrent_title = normalize(&filename.replace("_x", ""));

                let mut best_match: Option<(String, usize)> = None;

                for item in items {
                    let content_title = normalize(&item["title"].as_str().unwrap_or(""));
                    let distance = levenshtein_distance(&torrent_title, &content_title);

                    if distance == 0 {
                        best_match = Some((item["id"].as_str().unwrap().to_string(), distance));
                        break;
                    } else if distance < 5 {
                        if best_match.is_none() || distance < best_match.as_ref().unwrap().1 {
                            best_match = Some((item["id"].as_str().unwrap().to_string(), distance));
                        }
                    }
                }

                if let Some((id, distance)) = best_match {
                    torrent_map.insert(id.clone(), filename.clone());
                    matched += 1;
                    if distance > 0 {
                        println!("Fuzzy match (dist={}): {} -> {}", distance, filename, torrent_map.get(&id).unwrap());
                    }
                } else {
                    unmatched.push(torrent_title);
                }
            }
        }
    }

    println!("\nMatched: {}", matched);
    println!("Unmatched torrents: {}", unmatched.len());
    if !unmatched.is_empty() {
        println!("Unmatched samples: {:?}", &unmatched[..unmatched.len().min(10)]);
    }

    let mut enriched_with_torrents = enriched_data.clone();
    for item in enriched_with_torrents["items"].as_array_mut().unwrap() {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            if let Some(torrent_file) = torrent_map.get(id) {
                item["torrent_file"] = json!(torrent_file);
            }
        }
    }

    let output_path = PathBuf::from(&repo_root)
        .join("backend")
        .join("data")
        .join("enriched_400_with_torrents.json");
    fs::write(
        &output_path,
        serde_json::to_string_pretty(&enriched_with_torrents).unwrap(),
    )
    .expect("Failed to write enriched_400_with_torrents.json");

    println!(
        "\nWrote {} with {} torrent associations",
        output_path.display(),
        matched
    );
}
