// Generates prost types + serde (pbjson) for the event payloads in /proto/oryxa/events.
use prost::Message;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto");
    let fds = protox::compile([root.join("oryxa/events/v1/events.proto")], [&root])?;
    let bytes = fds.encode_to_vec();
    prost_build::Config::new().compile_fds(fds)?;
    pbjson_build::Builder::new()
        .register_descriptors(&bytes)?
        // snake_case keys, defaults always present (`allowed: false` must not vanish),
        // unknown fields tolerated so older consumers survive additive changes.
        .preserve_proto_field_names()
        .emit_fields()
        .ignore_unknown_fields()
        .build(&[".oryxa.events.v1"])?;
    println!("cargo:rerun-if-changed={}", root.join("oryxa/events").display());
    Ok(())
}
