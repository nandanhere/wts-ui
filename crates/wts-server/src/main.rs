#[tokio::main]
async fn main() -> wts_server::ServerResult<()> {
    wts_server::run().await
}
