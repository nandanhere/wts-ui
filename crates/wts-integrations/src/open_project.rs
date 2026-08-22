use reqwest::{
    StatusCode, Url,
    blocking::{Client, Response},
    header::{ACCEPT, AUTHORIZATION, HeaderValue},
    redirect::Policy,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::json;
use std::{
    fmt,
    io::{self, Read},
    net::IpAddr,
    time::Duration,
};

pub const WTS_OPENPROJECT_URL_ENV: &str = "WTS_OPENPROJECT_URL";
pub const WTS_OPENPROJECT_TOKEN_ENV: &str = "WTS_OPENPROJECT_TOKEN";

const HAL_JSON: &str = "application/hal+json";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 512 * 1024;
const MAX_SUBJECT_BYTES: usize = 16 * 1024;
const MAX_INSTANCE_NAME_BYTES: usize = 4 * 1024;
const MAX_LINK_BYTES: usize = 8 * 1024;
const MAX_LINK_TITLE_BYTES: usize = 4 * 1024;
const MAX_REFERENCE_BYTES: usize = 128;
const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_COLLECTION_ELEMENTS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenProjectVerification {
    pub connected: bool,
    pub instance_name: String,
    pub api_version: String,
    pub authenticated_user: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenProjectWorkPackage {
    pub work_package_id: u64,
    pub display_id: String,
    pub subject: String,
    pub status: Option<String>,
    pub project: Option<String>,
    pub content: String,
}

/// Stable adapter failures. No variant stores a URL, token, response body, or
/// provider-generated error string, keeping failures safe across IPC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenProjectError {
    EndpointMissing,
    TokenMissing,
    InvalidEndpoint,
    InvalidToken,
    InvalidReference,
    ClientInitializationFailed,
    RequestTimedOut,
    RequestFailed,
    ResponseTooLarge,
    ResponseInvalid,
    AuthenticationFailed,
    PermissionDenied,
    ResourceNotFound,
    AmbiguousReference,
    RateLimited,
    ServerRejected,
}

impl OpenProjectError {
    pub const fn safe_message(self) -> &'static str {
        match self {
            Self::EndpointMissing => "Configure WTS_OPENPROJECT_URL to connect OpenProject.",
            Self::TokenMissing => "Configure WTS_OPENPROJECT_TOKEN to connect OpenProject.",
            Self::InvalidEndpoint => {
                "The OpenProject URL must be a safe HTTPS URL or a loopback HTTP URL."
            }
            Self::InvalidToken => "The configured OpenProject token is invalid.",
            Self::InvalidReference => "Enter a numeric work package ID or display ID.",
            Self::ClientInitializationFailed => "WTS could not initialize its OpenProject client.",
            Self::RequestTimedOut => "OpenProject did not answer before the timeout.",
            Self::RequestFailed => "WTS could not reach OpenProject.",
            Self::ResponseTooLarge => "The OpenProject response exceeded WTS's local safety limit.",
            Self::ResponseInvalid => "OpenProject returned an invalid API v3 response.",
            Self::AuthenticationFailed => "OpenProject rejected the configured token.",
            Self::PermissionDenied => {
                "The configured OpenProject account cannot access that resource."
            }
            Self::ResourceNotFound => "OpenProject did not find the requested resource.",
            Self::AmbiguousReference => {
                "OpenProject returned more than one exact work package match."
            }
            Self::RateLimited => "OpenProject temporarily rate-limited this request.",
            Self::ServerRejected => "OpenProject rejected the API request.",
        }
    }
}

impl fmt::Display for OpenProjectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.safe_message())
    }
}

impl std::error::Error for OpenProjectError {}

#[derive(Clone)]
pub struct OpenProjectAdapter {
    client: Client,
    api_root: Url,
    authorization: HeaderValue,
}

impl fmt::Debug for OpenProjectAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenProjectAdapter")
            .finish_non_exhaustive()
    }
}

impl OpenProjectAdapter {
    pub fn from_env() -> Result<Self, OpenProjectError> {
        let endpoint = std::env::var(WTS_OPENPROJECT_URL_ENV)
            .map_err(|_| OpenProjectError::EndpointMissing)?;
        let token =
            std::env::var(WTS_OPENPROJECT_TOKEN_ENV).map_err(|_| OpenProjectError::TokenMissing)?;
        Self::new(&endpoint, &token)
    }

    /// Builds an adapter from host-owned configuration. This exists for the
    /// settings service and tests; callers must not persist or serialize the
    /// returned adapter.
    pub fn new(endpoint: &str, token: &str) -> Result<Self, OpenProjectError> {
        let api_root = api_root(endpoint)?;
        let authorization = authorization_header(token)?;
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(Policy::none())
            .user_agent("WTS OpenProject adapter")
            .build()
            .map_err(|_| OpenProjectError::ClientInitializationFailed)?;

        Ok(Self {
            client,
            api_root,
            authorization,
        })
    }

    pub fn verify(&self) -> Result<OpenProjectVerification, OpenProjectError> {
        let root: RootDocument = self.get_json(self.api_root.clone())?;
        if root.resource_type != "Root" {
            return Err(OpenProjectError::ResponseInvalid);
        }
        let work_packages = root
            .links
            .work_packages
            .as_ref()
            .ok_or(OpenProjectError::ResponseInvalid)?;
        validate_link(work_packages)?;
        let instance_name = root
            .instance_name
            .unwrap_or_else(|| "OpenProject".to_owned());
        validate_bounded_text(&instance_name, MAX_INSTANCE_NAME_BYTES, false)?;
        let current_user: UserDocument = self.get_json(self.endpoint(&["users", "me"])?)?;
        if current_user.resource_type != "User" || current_user.id == 0 {
            return Err(OpenProjectError::ResponseInvalid);
        }
        validate_bounded_text(&current_user.name, MAX_INSTANCE_NAME_BYTES, false)?;

        Ok(OpenProjectVerification {
            connected: true,
            instance_name,
            api_version: "v3".to_owned(),
            authenticated_user: current_user.name,
        })
    }

    pub fn get_work_package(
        &self,
        reference: &str,
    ) -> Result<OpenProjectWorkPackage, OpenProjectError> {
        let reference = validate_reference(reference)?;
        if reference.bytes().all(|byte| byte.is_ascii_digit()) {
            let numeric_id = reference
                .parse::<u64>()
                .map_err(|_| OpenProjectError::InvalidReference)?;
            if numeric_id == 0 {
                return Err(OpenProjectError::InvalidReference);
            }
            let document: WorkPackageDocument =
                self.get_json(self.endpoint(&["work_packages", reference])?)?;
            if document.id != numeric_id {
                return Err(OpenProjectError::ResponseInvalid);
            }
            return decode_work_package(document);
        }

        let mut endpoint = self.endpoint(&["work_packages"])?;
        let filters = json!([{
            "subjectOrId": {
                "operator": "**",
                "values": [reference]
            }
        }])
        .to_string();
        endpoint
            .query_pairs_mut()
            .append_pair("filters", &filters)
            .append_pair("pageSize", "25");

        let collection: WorkPackageCollection = self.get_json(endpoint)?;
        if collection.resource_type != "Collection"
            || collection.embedded.elements.len() > MAX_COLLECTION_ELEMENTS
        {
            return Err(OpenProjectError::ResponseInvalid);
        }
        let mut exact_matches = collection
            .embedded
            .elements
            .into_iter()
            .filter(|work_package| work_package.display_id.as_deref() == Some(reference));
        let exact_match = exact_matches
            .next()
            .ok_or(OpenProjectError::ResourceNotFound)?;
        if exact_matches.next().is_some() {
            return Err(OpenProjectError::AmbiguousReference);
        }
        decode_work_package(exact_match)
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, OpenProjectError> {
        let mut endpoint = self.api_root.clone();
        {
            let mut path = endpoint
                .path_segments_mut()
                .map_err(|_| OpenProjectError::InvalidEndpoint)?;
            path.pop_if_empty();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(endpoint)
    }

    fn get_json<T: DeserializeOwned>(&self, endpoint: Url) -> Result<T, OpenProjectError> {
        let response = self
            .client
            .get(endpoint)
            .header(ACCEPT, HAL_JSON)
            .header(AUTHORIZATION, self.authorization.clone())
            .send()
            .map_err(map_request_error)?;
        let response = ensure_success(response)?;
        let body = read_bounded(response)?;
        serde_json::from_slice(&body).map_err(|_| OpenProjectError::ResponseInvalid)
    }
}

fn api_root(endpoint: &str) -> Result<Url, OpenProjectError> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err(OpenProjectError::EndpointMissing);
    }
    let mut url = Url::parse(endpoint).map_err(|_| OpenProjectError::InvalidEndpoint)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(OpenProjectError::InvalidEndpoint);
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_host(&url) => {}
        _ => return Err(OpenProjectError::InvalidEndpoint),
    }

    let path = url.path().trim_end_matches('/').to_owned();
    if path.ends_with("/api/v3") {
        url.set_path(&path);
    } else {
        url.set_path(&format!("{path}/api/v3"));
    }
    Ok(url)
}

fn is_loopback_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']).trim_end_matches('.');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

fn authorization_header(token: &str) -> Result<HeaderValue, OpenProjectError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(OpenProjectError::TokenMissing);
    }
    if token.len() > MAX_TOKEN_BYTES || token.chars().any(char::is_control) {
        return Err(OpenProjectError::InvalidToken);
    }
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| OpenProjectError::InvalidToken)?;
    value.set_sensitive(true);
    Ok(value)
}

fn validate_reference(reference: &str) -> Result<&str, OpenProjectError> {
    let reference = reference.trim();
    if reference.is_empty()
        || reference.len() > MAX_REFERENCE_BYTES
        || !reference
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(OpenProjectError::InvalidReference);
    }
    Ok(reference)
}

fn map_request_error(error: reqwest::Error) -> OpenProjectError {
    if error.is_timeout() {
        OpenProjectError::RequestTimedOut
    } else {
        OpenProjectError::RequestFailed
    }
}

fn ensure_success(response: Response) -> Result<Response, OpenProjectError> {
    match response.status() {
        status if status.is_success() => Ok(response),
        StatusCode::UNAUTHORIZED => Err(OpenProjectError::AuthenticationFailed),
        StatusCode::FORBIDDEN => Err(OpenProjectError::PermissionDenied),
        StatusCode::NOT_FOUND => Err(OpenProjectError::ResourceNotFound),
        StatusCode::TOO_MANY_REQUESTS => Err(OpenProjectError::RateLimited),
        _ => Err(OpenProjectError::ServerRejected),
    }
}

fn read_bounded(response: Response) -> Result<Vec<u8>, OpenProjectError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(OpenProjectError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    response
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(map_body_error)?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(OpenProjectError::ResponseTooLarge);
    }
    Ok(body)
}

fn map_body_error(error: io::Error) -> OpenProjectError {
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) {
        OpenProjectError::RequestTimedOut
    } else {
        OpenProjectError::RequestFailed
    }
}

#[derive(Debug, Deserialize)]
struct RootDocument {
    #[serde(rename = "_type")]
    resource_type: String,
    #[serde(default, rename = "instanceName")]
    instance_name: Option<String>,
    #[serde(default, rename = "_links")]
    links: RootLinks,
}

#[derive(Debug, Default, Deserialize)]
struct RootLinks {
    #[serde(default, rename = "workPackages")]
    work_packages: Option<HalLink>,
}

#[derive(Debug, Deserialize)]
struct UserDocument {
    #[serde(rename = "_type")]
    resource_type: String,
    id: u64,
    name: String,
}

#[derive(Debug, Deserialize)]
struct WorkPackageCollection {
    #[serde(rename = "_type")]
    resource_type: String,
    #[serde(default, rename = "_embedded")]
    embedded: WorkPackageEmbedded,
}

#[derive(Debug, Default, Deserialize)]
struct WorkPackageEmbedded {
    #[serde(default)]
    elements: Vec<WorkPackageDocument>,
}

#[derive(Debug, Deserialize)]
struct WorkPackageDocument {
    #[serde(rename = "_type")]
    resource_type: String,
    id: u64,
    #[serde(default, rename = "displayId")]
    display_id: Option<String>,
    subject: String,
    #[serde(default)]
    description: Option<FormattedText>,
    #[serde(default, rename = "_links")]
    links: WorkPackageLinks,
}

#[derive(Debug, Deserialize)]
struct FormattedText {
    #[serde(default)]
    raw: String,
}

#[derive(Debug, Default, Deserialize)]
struct WorkPackageLinks {
    #[serde(default, rename = "self")]
    self_link: Option<HalLink>,
    #[serde(default)]
    project: Option<HalLink>,
    #[serde(default)]
    status: Option<HalLink>,
}

#[derive(Debug, Deserialize)]
struct HalLink {
    href: String,
    #[serde(default)]
    title: Option<String>,
}

fn decode_work_package(
    document: WorkPackageDocument,
) -> Result<OpenProjectWorkPackage, OpenProjectError> {
    if document.resource_type != "WorkPackage" || document.id == 0 {
        return Err(OpenProjectError::ResponseInvalid);
    }
    validate_bounded_text(&document.subject, MAX_SUBJECT_BYTES, false)?;
    let display_id = document
        .display_id
        .ok_or(OpenProjectError::ResponseInvalid)?;
    validate_bounded_text(&display_id, MAX_REFERENCE_BYTES, false)?;
    let description = document
        .description
        .map(|description| description.raw)
        .unwrap_or_default();
    validate_bounded_text(&description, MAX_DESCRIPTION_BYTES, true)?;
    let content = if description.is_empty() {
        document.subject.clone()
    } else {
        format!("{}\n\n{description}", document.subject)
    };

    let self_link = document
        .links
        .self_link
        .as_ref()
        .ok_or(OpenProjectError::ResponseInvalid)?;
    validate_link(self_link)?;
    let status = link_title(document.links.status.as_ref())?;
    let project = link_title(document.links.project.as_ref())?;

    Ok(OpenProjectWorkPackage {
        work_package_id: document.id,
        display_id,
        subject: document.subject,
        status,
        project,
        content,
    })
}

fn link_title(link: Option<&HalLink>) -> Result<Option<String>, OpenProjectError> {
    let Some(link) = link else {
        return Ok(None);
    };
    validate_link(link)?;
    Ok(link.title.clone())
}

fn validate_link(link: &HalLink) -> Result<(), OpenProjectError> {
    validate_bounded_text(&link.href, MAX_LINK_BYTES, false)?;
    if let Some(title) = &link.title {
        validate_bounded_text(title, MAX_LINK_TITLE_BYTES, true)?;
    }
    Ok(())
}

fn validate_bounded_text(
    value: &str,
    maximum_bytes: usize,
    allow_empty: bool,
) -> Result<(), OpenProjectError> {
    if value.len() > maximum_bytes
        || (!allow_empty && value.is_empty())
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(OpenProjectError::ResponseInvalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    type MockResponse = (&'static str, Vec<(String, String)>, String);

    #[test]
    fn endpoint_policy_accepts_https_and_loopback_http_only() {
        assert!(OpenProjectAdapter::new("https://openproject.example", "token").is_ok());
        assert!(OpenProjectAdapter::new("http://127.0.0.1:8080", "token").is_ok());
        assert!(OpenProjectAdapter::new("http://[::1]:8080", "token").is_ok());
        assert!(OpenProjectAdapter::new("http://localhost:8080", "token").is_ok());

        for endpoint in [
            "http://openproject.example",
            "https://user:password@openproject.example",
            "https://openproject.example?token=secret",
            "https://openproject.example#fragment",
            "ftp://openproject.example",
        ] {
            assert!(matches!(
                OpenProjectAdapter::new(endpoint, "token"),
                Err(OpenProjectError::InvalidEndpoint)
            ));
        }
    }

    #[test]
    fn adapter_debug_and_errors_do_not_expose_configuration() {
        let adapter =
            OpenProjectAdapter::new("https://private-openproject.example", "super-secret-token")
                .expect("valid adapter");
        let debug = format!("{adapter:?}");
        assert!(!debug.contains("private-openproject"));
        assert!(!debug.contains("super-secret-token"));

        for error in [
            OpenProjectError::RequestFailed,
            OpenProjectError::ResponseInvalid,
            OpenProjectError::AuthenticationFailed,
        ] {
            let message = error.to_string();
            assert!(!message.contains("private-openproject"));
            assert!(!message.contains("super-secret-token"));
        }
    }

    #[test]
    fn verifies_root_and_authenticated_user_with_hal_headers_and_bearer_auth() {
        let root_body = r#"{
          "_type": "Root",
          "instanceName": "Example OpenProject",
          "_links": {
            "workPackages": { "href": "/api/v3/work_packages" }
          }
        }"#;
        let user_body = r#"{
          "_type": "User",
          "id": 7,
          "name": "Ada Developer"
        }"#;
        let (endpoint, requests, server) = serve_sequence(vec![
            ("200 OK", Vec::new(), root_body.to_owned()),
            ("200 OK", Vec::new(), user_body.to_owned()),
        ]);
        let adapter = OpenProjectAdapter::new(&endpoint, "test-token").expect("adapter");

        let verification = adapter.verify().expect("verification");
        assert_eq!(
            verification,
            OpenProjectVerification {
                connected: true,
                instance_name: "Example OpenProject".to_owned(),
                api_version: "v3".to_owned(),
                authenticated_user: "Ada Developer".to_owned(),
            }
        );
        let root_request = requests.recv().expect("recorded root request");
        assert!(root_request.starts_with("GET /api/v3 HTTP/1.1\r\n"));
        assert!(
            root_request
                .to_ascii_lowercase()
                .contains("accept: application/hal+json\r\n")
        );
        assert!(root_request.contains("authorization: Bearer test-token\r\n"));
        let user_request = requests.recv().expect("recorded user request");
        assert!(user_request.starts_with("GET /api/v3/users/me HTTP/1.1\r\n"));
        assert!(user_request.contains("authorization: Bearer test-token\r\n"));
        server.join().expect("server thread");
    }

    #[test]
    fn imports_numeric_work_package_directly() {
        let body = work_package_json(42, "DEMO-42", "Fix the button");
        let (endpoint, request, server) = serve_once("200 OK", &[], &body);
        let adapter = OpenProjectAdapter::new(&endpoint, "token").expect("adapter");

        let work_package = adapter.get_work_package("42").expect("work package");
        assert_eq!(work_package.work_package_id, 42);
        assert_eq!(work_package.display_id, "DEMO-42");
        assert_eq!(work_package.subject, "Fix the button");
        assert_eq!(work_package.status.as_deref(), Some("In progress"));
        assert_eq!(work_package.project.as_deref(), Some("Demo"));
        assert_eq!(
            work_package.content,
            "Fix the button\n\nUse the primary color."
        );

        let request = request.recv().expect("recorded request");
        assert!(request.starts_with("GET /api/v3/work_packages/42 HTTP/1.1\r\n"));
        server.join().expect("server thread");
    }

    #[test]
    fn rejects_zero_work_package_id_without_a_request() {
        let adapter =
            OpenProjectAdapter::new("https://openproject.example", "token").expect("adapter");

        assert_eq!(
            adapter.get_work_package("0"),
            Err(OpenProjectError::InvalidReference)
        );
    }

    #[test]
    fn rejects_a_mismatched_work_package_id() {
        let body = work_package_json(41, "DEMO-41", "Wrong work package");
        let (endpoint, request, server) = serve_once("200 OK", &[], &body);
        let adapter = OpenProjectAdapter::new(&endpoint, "token").expect("adapter");

        assert_eq!(
            adapter.get_work_package("42"),
            Err(OpenProjectError::ResponseInvalid)
        );

        let request = request.recv().expect("recorded request");
        assert!(request.starts_with("GET /api/v3/work_packages/42 HTTP/1.1\r\n"));
        server.join().expect("server thread");
    }

    #[test]
    fn semantic_lookup_requires_an_exact_display_id_match() {
        let body = format!(
            r#"{{
              "_type": "Collection",
              "_embedded": {{
                "elements": [
                  {},
                  {}
                ]
              }}
            }}"#,
            work_package_json(41, "DEMO-410", "Near match"),
            work_package_json(42, "DEMO-42", "Exact match")
        );
        let (endpoint, request, server) = serve_once("200 OK", &[], &body);
        let adapter = OpenProjectAdapter::new(&endpoint, "token").expect("adapter");

        let work_package = adapter
            .get_work_package("DEMO-42")
            .expect("exact work package");
        assert_eq!(work_package.work_package_id, 42);
        assert_eq!(work_package.subject, "Exact match");

        let request = request.recv().expect("recorded request");
        assert!(request.starts_with("GET /api/v3/work_packages?"));
        assert!(request.contains("filters="));
        assert!(request.contains("pageSize=25"));
        server.join().expect("server thread");
    }

    #[test]
    fn redirects_are_not_followed() {
        let (endpoint, request, server) = serve_once(
            "302 Found",
            &[("Location", "https://credentials.invalid/api/v3")],
            "",
        );
        let adapter = OpenProjectAdapter::new(&endpoint, "token").expect("adapter");

        assert_eq!(adapter.verify(), Err(OpenProjectError::ServerRejected));
        let _ = request.recv().expect("recorded request");
        server.join().expect("server thread");
    }

    #[test]
    fn rejects_oversized_responses_before_reading_the_body() {
        let declared_size = (MAX_RESPONSE_BYTES + 1).to_string();
        let (endpoint, request, server) =
            serve_once("200 OK", &[("Content-Length", declared_size.as_str())], "");
        let adapter = OpenProjectAdapter::new(&endpoint, "token").expect("adapter");

        assert_eq!(adapter.verify(), Err(OpenProjectError::ResponseTooLarge));
        let _ = request.recv().expect("recorded request");
        server.join().expect("server thread");
    }

    fn work_package_json(id: u64, display_id: &str, subject: &str) -> String {
        format!(
            r#"{{
              "_type": "WorkPackage",
              "id": {id},
              "displayId": "{display_id}",
              "subject": "{subject}",
              "description": {{ "format": "plain", "raw": "Use the primary color." }},
              "_links": {{
                "self": {{ "href": "/api/v3/work_packages/{id}" }},
                "status": {{ "href": "/api/v3/statuses/7", "title": "In progress" }},
                "project": {{ "href": "/api/v3/projects/1", "title": "Demo" }}
              }}
            }}"#
        )
    }

    fn serve_once(
        status: &'static str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        serve_sequence(vec![(
            status,
            headers
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
            body.to_owned(),
        )])
    }

    fn serve_sequence(
        responses: Vec<MockResponse>,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback mock");
        let address = listener.local_addr().expect("mock address");
        let endpoint = format!("http://{address}");
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            for (status, headers, body) in responses {
                let (mut stream, _) = listener.accept().expect("accept request");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).expect("read request");
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                sender
                    .send(String::from_utf8(request).expect("utf8 request"))
                    .expect("send request");

                let has_content_length = headers
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case("content-length"));
                let mut response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {HAL_JSON}\r\nConnection: close\r\n"
                );
                for (name, value) in headers {
                    response.push_str(&format!("{name}: {value}\r\n"));
                }
                if !has_content_length {
                    response.push_str(&format!("Content-Length: {}\r\n", body.len()));
                }
                response.push_str("\r\n");
                stream
                    .write_all(response.as_bytes())
                    .expect("write response headers");
                stream
                    .write_all(body.as_bytes())
                    .expect("write response body");
            }
        });
        (endpoint, receiver, server)
    }
}
