// Compiles the vendored authzed/api protos with protox (no protoc install needed).
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto");
    let files = ["permission_service", "schema_service", "watch_service"]
        .map(|f| root.join(format!("authzed/api/v1/{f}.proto")));
    let fds = protox::compile(&files, [&root])?;
    tonic_prost_build::configure().build_server(false).compile_fds(fds)?;
    println!("cargo:rerun-if-changed={}", root.display());
    Ok(())
}
