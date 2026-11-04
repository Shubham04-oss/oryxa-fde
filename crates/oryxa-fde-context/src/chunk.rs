//! Splits a document's text into overlapping windows of words, small enough to embed and to show
//! as a search result. Deterministic: the same text always gives the same chunks.

use oryxa_fde_store::Text;

/// Words per chunk at most.
pub const WORDS_PER_CHUNK: usize = 200;
/// Characters per chunk at most (well inside the store's text limit).
pub const MAX_CHUNK_CHARS: usize = 2000;
/// Words a chunk repeats from the end of the one before, so a passage cut at a boundary is still
/// found whole in one of the two.
pub const OVERLAP_WORDS: usize = 40;
/// Chunks kept from one document at most.
pub const MAX_CHUNKS: usize = 2000;
/// Longer "words" (an encoded blob, a URL) are cut into pieces of this many characters.
const MAX_WORD_CHARS: usize = 100;

pub fn chunk(text: &str) -> Vec<Text> {
    let words: Vec<String> = text.split_whitespace().flat_map(pieces).collect();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < words.len() && chunks.len() < MAX_CHUNKS {
        let mut end = start;
        let mut chars = 0;
        while end < words.len() && end - start < WORDS_PER_CHUNK {
            let n = words[end].chars().count() + usize::from(end > start);
            if chars + n > MAX_CHUNK_CHARS {
                break;
            }
            chars += n;
            end += 1;
        }
        // Words are at most MAX_WORD_CHARS, so every chunk takes at least one.
        let end = end.max(start + 1);
        if let Ok(t) = Text::new(words[start..end].join(" ")) {
            chunks.push(t);
        }
        if end == words.len() {
            break;
        }
        // Always moves forward: the overlap is a fifth of the chunk at most.
        start = end - ((end - start) / 5).min(OVERLAP_WORDS);
    }
    chunks
}

fn pieces(word: &str) -> Vec<String> {
    let chars: Vec<char> = word.chars().filter(|c| !c.is_control()).collect();
    chars.chunks(MAX_WORD_CHARS).map(|c| c.iter().collect()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(n: usize) -> String {
        (0..n).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn short_text_is_one_chunk_with_whitespace_normalised() {
        let got = chunk("  Refund policy:\n\n\tover £500 needs approval.  ");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].as_str(), "Refund policy: over £500 needs approval.");
        assert!(chunk(" \n\t").is_empty());
    }

    #[test]
    fn long_text_becomes_overlapping_windows_covering_every_word() {
        let got = chunk(&words(450));
        let lens: Vec<usize> = got.iter().map(|c| c.as_str().split(' ').count()).collect();
        assert_eq!(lens, [200, 200, 130]);
        // Each chunk starts with the last 40 words of the one before.
        assert!(got[1].as_str().starts_with("w160 w161"));
        assert!(got[2].as_str().starts_with("w320 "));
        assert!(got[2].as_str().ends_with("w449"));
        assert_eq!(chunk(&words(450)), got, "deterministic");
    }

    #[test]
    fn chunks_stay_inside_the_character_limit() {
        let long = vec!["x".repeat(99); 300].join(" ");
        for c in chunk(&long) {
            assert!(c.as_str().chars().count() <= MAX_CHUNK_CHARS);
        }
        // A word longer than the cap is cut, not dropped.
        let blob = "y".repeat(250);
        let got = chunk(&blob);
        assert_eq!(got[0].as_str().replace(' ', ""), blob);
    }

    #[test]
    fn a_huge_document_is_capped() {
        let got = chunk(&words(WORDS_PER_CHUNK * (MAX_CHUNKS + 10)));
        assert_eq!(got.len(), MAX_CHUNKS);
    }
}
