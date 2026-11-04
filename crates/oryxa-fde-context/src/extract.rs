//! Text out of an uploaded file: plain text and Markdown as they are, PDF through `lopdf`, DOCX
//! from its `word/document.xml`. Everything here is untrusted input, so each reader is bounded
//! and a reader that fails (or panics) makes the document unreadable, never the worker.

use std::io::{Cursor, Read};

use oryxa_fde_store::ContentType;
use quick_xml::events::Event;

/// Longest text kept from one document; the rest is dropped.
pub const MAX_TEXT_CHARS: usize = 2_000_000;
/// Largest `word/document.xml` read from a DOCX (it is compressed in the file).
const MAX_DOCX_XML_BYTES: u64 = 64 * 1024 * 1024;
/// Largest any one PDF stream may decompress to while the file loads (its object and
/// cross-reference streams are read then); lopdf's own default is 256 MiB.
const MAX_PDF_STREAM_BYTES: usize = 8 * 1024 * 1024;
/// Page content one PDF's text is read from, shared by all its pages.
const MAX_PDF_CONTENT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ExtractError {
    #[error("the file could not be read as its type")]
    Unreadable,
    #[error("the file holds no text")]
    Empty,
    #[error("the file expands past the size limit")]
    TooLarge,
}

impl ExtractError {
    /// Stored on the document as the reason ingestion gave up.
    pub fn code(self) -> &'static str {
        match self {
            ExtractError::Unreadable => "unreadable",
            ExtractError::Empty => "empty",
            ExtractError::TooLarge => "too_large",
        }
    }
}

/// The document's text, with control characters (other than newlines and tabs) removed.
pub fn extract(content_type: ContentType, bytes: &[u8]) -> Result<String, ExtractError> {
    let raw = match content_type {
        ContentType::Text | ContentType::Markdown => String::from_utf8_lossy(bytes).into_owned(),
        ContentType::Pdf => pdf(bytes)?,
        ContentType::Docx => docx(bytes)?,
    };
    let text: String = raw
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(MAX_TEXT_CHARS)
        .collect();
    if text.trim().is_empty() {
        Err(ExtractError::Empty)
    } else {
        Ok(text)
    }
}

/// Like [`extract`], but a panic inside a reader (some PDF parsers panic on malformed input) is
/// caught and reported as unreadable. CPU-bound: run it on a blocking thread.
pub fn extract_guarded(content_type: ContentType, bytes: &[u8]) -> Result<String, ExtractError> {
    std::panic::catch_unwind(|| extract(content_type, bytes)).unwrap_or(Err(ExtractError::Unreadable))
}

// ponytail: page content draws on one budget for the whole file, but loading bounds each object
// stream (MAX_PDF_STREAM_BYTES), not their total, so a file of many small bombs can still exhaust
// the ingest worker. It takes one message at a time, so that costs only this document, whose event
// reaches the dead-letter queue after its redeliveries.
fn pdf(bytes: &[u8]) -> Result<String, ExtractError> {
    pdf_within(bytes, MAX_PDF_STREAM_BYTES, MAX_PDF_CONTENT_BYTES)
}

/// [`pdf`] with its limits as parameters, so tests reach them with small files.
fn pdf_within(bytes: &[u8], stream_limit: usize, content_budget: usize) -> Result<String, ExtractError> {
    let options = lopdf::LoadOptions {
        max_decompressed_size: Some(stream_limit),
        ..Default::default()
    };
    let doc = lopdf::Document::load_mem_with_options(bytes, options).map_err(|e| {
        if over_limit(&e) {
            ExtractError::TooLarge
        } else {
            ExtractError::Unreadable
        }
    })?;
    let mut left = content_budget;
    let mut out = String::new();
    for (number, page) in doc.get_pages() {
        // Measured within what is left before its text is read: every page draws on one budget.
        let size = match doc.get_page_content_with_limit(page, left) {
            Ok(content) => content.len(),
            Err(e) if over_limit(&e) => return Err(ExtractError::TooLarge),
            // A page that cannot be read is skipped; the rest of the document still counts.
            Err(_) => continue,
        };
        // Each stream the text is read from (the content, its fonts) is bounded by what is left.
        if let Ok(t) = doc.extract_text_with_limit(&[number], left) {
            out.push_str(&t);
            out.push('\n');
        }
        left -= size;
        if out.len() > MAX_TEXT_CHARS * 4 {
            break;
        }
    }
    Ok(out)
}

fn over_limit(e: &lopdf::Error) -> bool {
    matches!(
        e,
        lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded { .. })
    )
}

fn docx(bytes: &[u8]) -> Result<String, ExtractError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| ExtractError::Unreadable)?;
    let file = zip.by_name("word/document.xml").map_err(|_| ExtractError::Unreadable)?;
    if file.size() > MAX_DOCX_XML_BYTES {
        return Err(ExtractError::TooLarge);
    }
    // The declared size can lie; never read past the limit.
    let mut xml = Vec::new();
    file.take(MAX_DOCX_XML_BYTES + 1)
        .read_to_end(&mut xml)
        .map_err(|_| ExtractError::Unreadable)?;
    if xml.len() as u64 > MAX_DOCX_XML_BYTES {
        return Err(ExtractError::TooLarge);
    }
    docx_text(&xml)
}

/// The text of WordprocessingML: runs of `w:t`, a tab for `w:tab`, a line break for `w:br` and
/// the end of each paragraph `w:p`.
fn docx_text(xml: &[u8]) -> Result<String, ExtractError> {
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.name().as_ref() == "w:t" => in_text = true,
            Ok(Event::End(e)) => match e.name().as_ref() {
                "w:t" => in_text = false,
                "w:p" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Empty(e)) => match e.name().as_ref() {
                "w:tab" => out.push('\t'),
                "w:br" | "w:p" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Text(t)) if in_text => out.push_str(&t.xml_content(quick_xml::XmlVersion::Implicit1_0)),
            Ok(Event::GeneralRef(r)) if in_text => match r.resolve_char_ref() {
                Ok(Some(c)) => out.push(c),
                _ => out.push_str(match r.as_ref() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    _ => "",
                }),
            },
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err(ExtractError::Unreadable),
        }
        buf.clear();
        if out.len() > MAX_TEXT_CHARS * 4 {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use super::*;

    /// A minimal DOCX holding `document_xml`.
    pub(crate) fn docx_file(document_xml: &str) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut out);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("word/document.xml", opts).unwrap();
        zip.write_all(document_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
        out.into_inner()
    }

    /// A one-page PDF showing `text` (ASCII, no parentheses or backslashes).
    pub(crate) fn pdf_file(text: &str) -> Vec<u8> {
        pdf_pages(&[text], lopdf::SaveOptions::default())
    }

    /// A PDF with one page per text, saved with `options`; page content is compressed.
    fn pdf_pages(texts: &[&str], options: lopdf::SaveOptions) -> Vec<u8> {
        use lopdf::content::{Content, Operation};
        use lopdf::{Document, Object, Stream, dictionary};
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let resources_id = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font_id } });
        let mut kids: Vec<Object> = Vec::new();
        for text in texts {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 12.into()]),
                    Operation::new("Td", vec![72.into(), 720.into()]),
                    Operation::new("Tj", vec![Object::string_literal(*text)]),
                    Operation::new("ET", vec![]),
                ],
            };
            let mut stream = Stream::new(dictionary! {}, content.encode().unwrap());
            stream.compress().unwrap();
            let content_id = doc.add_object(stream);
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
            });
            kids.push(page_id.into());
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Count" => kids.len() as i64, "Kids" => kids,
                "Resources" => resources_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut out = Vec::new();
        doc.save_with_options(&mut out, options).unwrap();
        out
    }

    #[test]
    fn text_and_markdown_are_read_as_utf8_without_control_characters() {
        let got = extract(ContentType::Markdown, b"# Runbook\n\tRestart \x07the \x00queue\r\n").unwrap();
        assert_eq!(got, "# Runbook\n\tRestart the queue\n");
        assert_eq!(extract(ContentType::Text, "caf\u{e9}".as_bytes()).unwrap(), "caf\u{e9}");
        assert_eq!(extract(ContentType::Text, b"  \n\t "), Err(ExtractError::Empty));
    }

    #[test]
    fn docx_paragraphs_runs_tabs_and_entities() {
        let xml = r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
            <w:p><w:r><w:t>Refunds over</w:t></w:r><w:r><w:t xml:space="preserve"> &amp;pound;500</w:t></w:r></w:p>
            <w:p><w:r><w:t>Escalate</w:t><w:tab/><w:t>to &#x4C;2</w:t><w:br/><w:t>within 4h</w:t></w:r></w:p>
            <w:p/></w:body></w:document>"#;
        let got = extract(ContentType::Docx, &docx_file(xml)).unwrap();
        assert_eq!(got, "Refunds over &pound;500\nEscalate\tto L2\nwithin 4h\n\n");
    }

    #[test]
    fn pdf_text_is_extracted() {
        let got = extract(ContentType::Pdf, &pdf_file("Tier-1 tickets are answered in 2 minutes")).unwrap();
        assert!(got.contains("Tier-1 tickets are answered in 2 minutes"), "{got:?}");
    }

    #[test]
    fn broken_files_are_unreadable_not_a_crash() {
        for (ct, bytes) in [
            (ContentType::Pdf, b"%PDF-1.4 garbage".to_vec()),
            (ContentType::Docx, b"PK\x03\x04 not a zip".to_vec()),
            (
                ContentType::Docx,
                docx_file("<w:document><w:p><w:t>mismatched</w:p></w:t>"),
            ),
        ] {
            let got = extract_guarded(ct, &bytes);
            assert!(
                matches!(got, Err(ExtractError::Unreadable | ExtractError::Empty)),
                "{ct:?}: {got:?}"
            );
        }
        // Cut short: what was read so far still counts.
        let cut = extract(ContentType::Docx, &docx_file("<w:document><w:p><w:t>cut short"));
        assert_eq!(cut.as_deref(), Ok("cut short"));
        // A DOCX without its main part.
        let mut out = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut out);
        zip.start_file("other.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        assert_eq!(
            extract(ContentType::Docx, &out.into_inner()),
            Err(ExtractError::Unreadable)
        );
    }

    #[test]
    fn every_page_of_a_pdf_draws_on_one_content_budget() {
        // Two pages of about 1,000 bytes of content each, compressed to far less in the file.
        let (a, b) = ("a".repeat(1000), "b".repeat(1000));
        let file = pdf_pages(&[&a, &b], lopdf::SaveOptions::default());
        assert!(file.len() < 2000, "{} bytes", file.len());
        let both = pdf_within(&file, 1 << 20, 4000).unwrap();
        assert!(both.contains(&a) && both.contains(&b));
        // Either page alone fits in 1,500 bytes, but not both: the budget is shared.
        assert_eq!(pdf_within(&file, 1 << 20, 1500), Err(ExtractError::TooLarge));
        assert_eq!(pdf_within(&file, 1 << 20, 500), Err(ExtractError::TooLarge));
    }

    #[test]
    fn a_pdf_stream_that_inflates_past_the_load_limit_is_refused() {
        // Its pages and fonts packed into an object stream, which lopdf inflates as it loads.
        let modern = lopdf::SaveOptions::builder()
            .use_object_streams(true)
            .use_xref_streams(true)
            .build();
        let file = pdf_pages(&["Packed in an object stream"], modern);
        assert!(
            pdf_within(&file, 1 << 20, 1 << 20)
                .unwrap()
                .contains("Packed in an object stream")
        );
        assert_eq!(pdf_within(&file, 64, 1 << 20), Err(ExtractError::TooLarge));
    }

    #[test]
    fn a_docx_that_inflates_past_the_limit_is_refused() {
        // Highly compressible: a few hundred KiB in the file, over the limit once inflated.
        let xml = "a".repeat(MAX_DOCX_XML_BYTES as usize + 1);
        let file = docx_file(&xml);
        assert!(file.len() < 1024 * 1024);
        assert_eq!(extract(ContentType::Docx, &file), Err(ExtractError::TooLarge));
    }
}
