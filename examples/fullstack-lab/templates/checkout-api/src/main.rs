use std::{
    env,
    error::Error,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
};

const MAX_REQUEST_BYTES: usize = 8 * 1024;

fn main() -> Result<(), Box<dyn Error>> {
    let port = env::var("CHECKOUT_API_PORT")?.parse::<u16>()?;
    if port < 1_024 {
        return Err("CHECKOUT_API_PORT must be an unprivileged TCP port".into());
    }

    let listener = TcpListener::bind(("127.0.0.1", port))?;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle(stream)?,
            Err(error) => eprintln!("checkout-api connection failed: {error}"),
        }
    }
    Ok(())
}

fn handle(mut stream: TcpStream) -> std::io::Result<()> {
    let mut request = [0_u8; MAX_REQUEST_BYTES];
    let bytes = stream.read(&mut request)?;
    let request = &request[..bytes];
    let (status, body) = if request.starts_with(b"GET /health ") {
        ("200 OK", r#"{"status":"ok","service":"checkout-api"}"#)
    } else {
        ("404 Not Found", r#"{"error":"not_found"}"#)
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}
