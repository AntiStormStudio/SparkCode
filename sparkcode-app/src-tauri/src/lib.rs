use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Clone, Serialize)]
struct Session {
    id: String,
    title: String,
    tokens: u32,
    context_used: u32,
    context_limit: u32,
    project_path: String,
    remote: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct RemoteConfig {
    backend_url: Option<String>,
    configured: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct SparkUserProfile {
    logged_in: bool,
    id: Option<String>,
    name: Option<String>,
    email: Option<String>,
    avatar_url: Option<String>,
    organization_id: Option<String>,
    organization_name: Option<String>,
    billing_type: Option<String>,
    account_created_at: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct RemoteDeviceBinding {
    configured: bool,
    bound: bool,
    install_id: Option<String>,
    device_id: Option<String>,
    binding_id: Option<String>,
    client_name: Option<String>,
    package_name: String,
    app_version: String,
    status: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct RemoteClientConfig {
    binding_id: Option<String>,
    client_token: Option<String>,
    endpoint: Option<String>,
    stream_endpoint: Option<String>,
    client_name: Option<String>,
    status: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct AppPreferences {
    permission_mode: String,
    remote_control_at_startup: Option<bool>,
    auto_compact_enabled: bool,
    show_turn_duration: bool,
    terminal_progress_bar_enabled: bool,
    file_checkpointing_enabled: bool,
    respect_gitignore: bool,
    copy_full_response: bool,
    auto_connect_ide: bool,
    auto_install_ide_extension: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct ModelOption {
    id: String,
    name: String,
    description: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct ModelConfig {
    selected: String,
    options: Vec<ModelOption>,
}

#[derive(Clone, Deserialize, Serialize)]
struct RecentChange {
    id: String,
    title: String,
    path: String,
    summary: String,
    timestamp: String,
    status: String,
    can_revert: bool,
    before_content: Option<String>,
    #[serde(default)]
    added_lines: u32,
    #[serde(default)]
    removed_lines: u32,
}

#[derive(Clone, Deserialize, Serialize)]
struct SlashCommandEntry {
    name: String,
    description: String,
    aliases: Vec<String>,
    category: String,
    accepts_args: bool,
    #[serde(default, rename = "type")]
    command_type: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    loaded_from: Option<String>,
    #[serde(default)]
    argument_hint: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ToolEntry {
    name: String,
    description: String,
    source: String,
    category: String,
    read_only: Option<bool>,
    enabled: bool,
    mcp_server: Option<String>,
    mcp_tool: Option<String>,
    input_schema: Option<Value>,
    should_defer: bool,
}

#[derive(Serialize)]
struct AppSnapshot {
    version: String,
    remote: RemoteConfig,
    spark_user: SparkUserProfile,
    remote_device: RemoteDeviceBinding,
    preferences: AppPreferences,
    model: ModelConfig,
    workspace: WorkspaceInfo,
    skills: Vec<SkillEntry>,
    mcp_servers: Vec<McpServerEntry>,
    tools: Vec<ToolEntry>,
    projects: Vec<ProjectEntry>,
    recent_changes: Vec<RecentChange>,
    slash_commands: Vec<SlashCommandEntry>,
    backend_runtime: BackendRuntime,
    update_status: UpdateStatus,
    sessions: Vec<Session>,
}

#[derive(Serialize)]
struct BackendRuntime {
    local_url: Option<String>,
    auth_token: String,
    streaming_enabled: bool,
    context_limit: u32,
}

#[derive(Clone, Serialize)]
struct UpdateStatus {
    current_version: String,
    current_revision: Option<String>,
    latest_revision: Option<String>,
    checked_at: u64,
    update_available: bool,
    source: String,
    detail: String,
    release_url: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct ChatMessage {
    id: String,
    role: String,
    content: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct ImageAttachment {
    id: String,
    name: String,
    media_type: String,
    data: String,
}

#[derive(Serialize)]
struct WorkspaceInfo {
    folder: String,
    path: String,
    mode: String,
    git_branch: Option<String>,
}

#[derive(Serialize)]
struct SkillEntry {
    id: String,
    name: String,
    source: String,
    path: String,
    description: Option<String>,
}

#[derive(Serialize)]
struct McpServerEntry {
    id: String,
    name: String,
    source: String,
    transport: String,
    command: Option<String>,
    url: Option<String>,
    enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct ProjectEntry {
    id: String,
    name: String,
    path: String,
    git_branch: Option<String>,
    trust_level: Option<String>,
}

#[derive(Clone, Serialize)]
struct ProjectFileEntry {
    path: String,
    name: String,
}

#[derive(Clone, Serialize)]
struct ProjectDirectoryEntry {
    path: String,
    name: String,
    is_dir: bool,
    size: u64,
    modified_at: Option<u64>,
}

#[derive(Clone, Serialize)]
struct ProjectFileDocument {
    path: String,
    name: String,
    content: String,
    exists: bool,
    size: u64,
    modified_at: Option<u64>,
    recent_changes: Vec<RecentChange>,
}

#[derive(Serialize)]
struct MemoryDocument {
    path: String,
    content: String,
    exists: bool,
}

#[derive(Default, Deserialize, Serialize)]
struct ProjectOverrides {
    added: Vec<ProjectEntry>,
    removed: Vec<String>,
}

static REMOTE_CONFIG: OnceLock<Mutex<RemoteConfig>> = OnceLock::new();
static MODEL_CONFIG: OnceLock<Mutex<ModelConfig>> = OnceLock::new();
static BACKEND_PROCESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static APP_SESSIONS: OnceLock<Mutex<Vec<Session>>> = OnceLock::new();
static ACTIVE_PROJECT_PATH: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static STALE_BACKEND_CLEANUP_DONE: OnceLock<()> = OnceLock::new();
static FALLBACK_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

const FIXED_BACKEND_URL: &str = "https://chat.spark-ai.top";
const LOCAL_BACKEND_AUTH_TOKEN: &str = "sparkcode-app-local";
const SPARK_INSTALL_ID_ENV_KEY: &str = "SPARK_ANDROID_INSTALL_ID";
const SPARK_DEVICE_ID_ENV_KEY: &str = "SPARK_ANDROID_DEVICE_ID";
const SPARK_REFRESH_TOKEN_ENV_KEY: &str = "SPARK_ANDROID_REFRESH_TOKEN";
const SPARK_AUTH_TOKEN_ENV_KEY: &str = "ANTHROPIC_AUTH_TOKEN";
const SPARK_BASE_URL_ENV_KEY: &str = "ANTHROPIC_BASE_URL";
const BUNDLED_BACKEND_ROOT_ENV_KEY: &str = "SPARK_CODE_BUNDLED_BACKEND_ROOT";
const SPARK_PACKAGE_NAME: &str = "com.sparkatlas.app";
const SPARK_APP_VERSION: &str = "9.0.3";
const SPARK_CERT_SHA256: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OAUTH_CALLBACK_PATH: &str = "/spark/oauth/callback";
const SPARK_OAUTH_AUTHORIZE_PATH: &str = "/oauth/mobile/authorize";
const SPARK_AUTH_REFRESH_PATH: &str = "/api/v1/android/auth/refresh";
const SPARK_OAUTH_USERINFO_PATH: &str = "/oauth2/userinfo";
const SPARK_CODE_API_PATH: &str = "/api/v1/spark-code";
const SPARK_MODEL_LIST_PATH: &str = "/api/v1/android/models";
const UPDATE_CHECK_BRANCH: &str = "main";

fn default_remote_config() -> RemoteConfig {
    RemoteConfig {
        backend_url: Some(FIXED_BACKEND_URL.to_string()),
        configured: true,
    }
}

fn default_spark_code_endpoint() -> String {
    format!("{FIXED_BACKEND_URL}{SPARK_CODE_API_PATH}")
}

fn is_loopback_endpoint(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let without_user = without_scheme
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(without_scheme);
    let authority = without_user.split('/').next().unwrap_or(without_user);
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next().unwrap_or(stripped)
    } else {
        authority.split(':').next().unwrap_or(authority)
    }
    .to_ascii_lowercase();

    host == "localhost" || host == "0.0.0.0" || host == "::1" || host.starts_with("127.")
}

fn resolve_remote_response_endpoint(value: Option<String>) -> Option<String> {
    match value {
        Some(endpoint) if is_loopback_endpoint(&endpoint) => Some(default_spark_code_endpoint()),
        endpoint => endpoint,
    }
}

fn resolve_remote_response_stream_endpoint(
    value: Option<String>,
    endpoint: &Option<String>,
) -> Option<String> {
    match value {
        Some(stream_endpoint) if is_loopback_endpoint(&stream_endpoint) => endpoint
            .as_ref()
            .map(|base| format!("{base}/client/sessions/{{session_id}}/events/stream")),
        stream_endpoint => stream_endpoint,
    }
}

fn remote_config() -> &'static Mutex<RemoteConfig> {
    REMOTE_CONFIG.get_or_init(|| Mutex::new(default_remote_config()))
}

fn default_model_options() -> Vec<ModelOption> {
    Vec::new()
}

fn default_model_config() -> ModelConfig {
    ModelConfig {
        selected: String::new(),
        options: default_model_options(),
    }
}

fn model_config_with_options(options: Vec<ModelOption>) -> ModelConfig {
    let selected = options
        .first()
        .map(|option| option.id.clone())
        .unwrap_or_default();
    ModelConfig { selected, options }
}

fn ensure_selected_model_option(mut config: ModelConfig) -> ModelConfig {
    if config.selected.trim().is_empty() {
        config.selected = config
            .options
            .first()
            .map(|option| option.id.clone())
            .unwrap_or_default();
    }
    if !config
        .options
        .iter()
        .any(|option| option.id == config.selected)
    {
        config.selected = config
            .options
            .first()
            .map(|option| option.id.clone())
            .unwrap_or_default();
    }
    config
}

fn model_options_from_value(value: &Value) -> Vec<ModelOption> {
    let Some(items) = value
        .get("options")
        .and_then(Value::as_array)
        .or_else(|| value.get("items").and_then(Value::as_array))
        .or_else(|| value.get("data").and_then(Value::as_array))
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array())
    else {
        return Vec::new();
    };

    let mut options = Vec::new();
    for item in items {
        let Some(id) = value_string(item.get("id")).or_else(|| value_string(item.get("value")))
        else {
            continue;
        };
        let name = value_string(item.get("name"))
            .or_else(|| value_string(item.get("label")))
            .unwrap_or_else(|| id.clone());
        let description = value_string(item.get("description")).unwrap_or_default();
        if !options.iter().any(|option: &ModelOption| option.id == id) {
            options.push(ModelOption {
                id,
                name,
                description,
            });
        }
    }

    options
}

fn remote_backend_model_options() -> Vec<ModelOption> {
    let config = read_spark_config();
    let Some(auth_token) = env_string(&config, SPARK_AUTH_TOKEN_ENV_KEY) else {
        return Vec::new();
    };
    let url = format!("{FIXED_BACKEND_URL}{SPARK_MODEL_LIST_PATH}");
    let Ok(value) = curl_json(&[
        "-sS".to_string(),
        "--max-time".to_string(),
        "3".to_string(),
        "-w".to_string(),
        "\n%{http_code}".to_string(),
        "-H".to_string(),
        format!("Authorization: Bearer {auth_token}"),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
        url,
    ]) else {
        return Vec::new();
    };
    model_options_from_value(&value)
}

fn backend_model_options() -> Vec<ModelOption> {
    let remote_options = remote_backend_model_options();
    if !remote_options.is_empty() {
        return remote_options;
    }

    start_spark_backend();
    let Ok(value) = post_local_backend_json("/model-options", &serde_json::json!({})) else {
        return Vec::new();
    };
    model_options_from_value(&value)
}

fn model_config() -> &'static Mutex<ModelConfig> {
    MODEL_CONFIG.get_or_init(|| Mutex::new(default_model_config()))
}

fn app_sessions() -> &'static Mutex<Vec<Session>> {
    APP_SESSIONS.get_or_init(|| Mutex::new(Vec::new()))
}

fn active_project_path() -> &'static Mutex<Option<String>> {
    ACTIVE_PROJECT_PATH.get_or_init(|| Mutex::new(None))
}

fn config_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法访问应用配置目录".to_string())?;
    Ok(dir.join(file_name))
}

fn normalize_permission_mode(value: &str) -> String {
    match value.trim() {
        "auto-review" | "acceptEdits" | "auto" => "auto-review".to_string(),
        "full" | "bypassPermissions" | "dangerously-skip-permissions" => "full".to_string(),
        _ => "limited".to_string(),
    }
}

fn backend_permission_mode(value: &str) -> &'static str {
    match normalize_permission_mode(value).as_str() {
        "auto-review" => "acceptEdits",
        "full" => "bypassPermissions",
        _ => "default",
    }
}

fn load_project_overrides(app: &tauri::AppHandle) -> ProjectOverrides {
    let Ok(path) = config_path(app, "project-overrides.json") else {
        return ProjectOverrides::default();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return ProjectOverrides::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn persist_project_overrides(
    app: &tauri::AppHandle,
    overrides: &ProjectOverrides,
) -> Result<(), String> {
    let path = config_path(app, "project-overrides.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(overrides)
        .map_err(|error| format!("无法序列化目录配置：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存目录配置：{error}"))
}

fn spark_config_path() -> Result<PathBuf, String> {
    if let Some(config_dir) = env::var_os("SPARK_CONFIG_DIR") {
        return Ok(PathBuf::from(config_dir).join("spark.json"));
    }
    let home = env::var_os("HOME").ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".sparkc").join("spark.json"))
}

fn read_spark_config() -> Value {
    let Ok(path) = spark_config_path() else {
        return Value::Object(Map::new());
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Value::Object(Map::new());
    };
    serde_json::from_str(&content).unwrap_or_else(|_| Value::Object(Map::new()))
}

fn write_spark_config(config: &Value) -> Result<(), String> {
    let path = spark_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 Spark 配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("无法序列化 Spark 配置：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存 Spark 配置：{error}"))
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn value_u32(value: Option<&Value>) -> Option<u32> {
    value.and_then(Value::as_u64).and_then(|number| {
        if number <= u32::MAX as u64 {
            Some(number as u32)
        } else {
            None
        }
    })
}

fn env_string(config: &Value, key: &str) -> Option<String> {
    value_string(config.get("env").and_then(|env| env.get(key))).or_else(|| {
        env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn root_object_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    if !config.is_object() {
        *config = Value::Object(Map::new());
    }
    config
        .as_object_mut()
        .ok_or_else(|| "Spark 配置格式无效".to_string())
}

fn env_object_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    let root = root_object_mut(config)?;
    let env_value = root
        .entry("env".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !env_value.is_object() {
        *env_value = Value::Object(Map::new());
    }
    env_value
        .as_object_mut()
        .ok_or_else(|| "Spark 环境配置格式无效".to_string())
}

fn normalize_backend_base_url(raw_value: &str) -> Result<String, String> {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return Err("后端地址不能为空".to_string());
    }

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let (scheme, rest) = with_scheme
        .split_once("://")
        .ok_or_else(|| "后端地址格式无效，请填写类似 https://api.example.com".to_string())?;
    if scheme != "http" && scheme != "https" {
        return Err("后端地址只支持 http 或 https".to_string());
    }
    if rest.contains('?') || rest.contains('#') {
        return Err("后端地址不能包含查询参数或哈希".to_string());
    }

    let authority = rest.split('/').next().unwrap_or("").trim();
    if authority.is_empty() {
        return Err("后端地址缺少域名".to_string());
    }
    if authority.contains('@') {
        return Err("后端地址不能包含用户名或密码".to_string());
    }

    let path = rest
        .split_once('/')
        .map(|(_, path)| path.trim_matches('/'))
        .unwrap_or("");
    if path == "v1" {
        return Err("后端地址不要包含 /v1，请仅填写根地址".to_string());
    }
    if !path.is_empty() {
        return Err("后端地址不能包含路径，请仅填写协议和域名（可带端口）".to_string());
    }

    Ok(format!("{scheme}://{authority}"))
}

fn get_or_create_android_device(config: &mut Value) -> Result<(String, String), String> {
    let env_root = env_object_mut(config)?;
    let install_id = value_string(env_root.get(SPARK_INSTALL_ID_ENV_KEY))
        .unwrap_or_else(|| compact_id("spark-code-"));
    let device_id = value_string(env_root.get(SPARK_DEVICE_ID_ENV_KEY))
        .unwrap_or_else(|| compact_id("spark-device-"));

    env_root.insert(
        SPARK_INSTALL_ID_ENV_KEY.to_string(),
        Value::String(install_id.clone()),
    );
    env_root.insert(
        SPARK_DEVICE_ID_ENV_KEY.to_string(),
        Value::String(device_id.clone()),
    );

    Ok((install_id, device_id))
}

fn config_bool(config: &Value, key: &str, default: bool) -> bool {
    config.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn read_json_file(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn read_skill_description(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(30) {
        let trimmed = line.trim();
        if let Some(description) = trimmed.strip_prefix("description:") {
            let value = description.trim().trim_matches('"').to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn collect_skills_from_dir(root: &Path, source: &str, out: &mut Vec<SkillEntry>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_path = path.join("SKILL.md");
        if !skill_path.is_file() {
            collect_skills_from_dir(&path, source, out);
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill")
            .to_string();
        out.push(SkillEntry {
            id: format!("{source}:{name}:{}", out.len()),
            name,
            source: source.to_string(),
            path: skill_path.display().to_string(),
            description: read_skill_description(&skill_path),
        });
    }
}

fn load_user_skills() -> Vec<SkillEntry> {
    let mut out = Vec::new();
    let Some(home) = home_dir() else {
        return out;
    };

    collect_skills_from_dir(&home.join(".codex").join("skills"), "codex", &mut out);
    collect_skills_from_dir(
        &home.join(".codex").join("vendor_imports").join("skills"),
        "codex",
        &mut out,
    );
    collect_skills_from_dir(&home.join(".claude").join("skills"), "claude", &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn mcp_entry_from_json(name: &str, source: &str, value: &Value) -> McpServerEntry {
    let command = value_string(value.get("command"));
    let url = value_string(value.get("url"));
    let transport = value_string(value.get("type")).unwrap_or_else(|| {
        if url.is_some() {
            "http".to_string()
        } else {
            "stdio".to_string()
        }
    });
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    McpServerEntry {
        id: format!("{source}:{name}"),
        name: name.to_string(),
        source: source.to_string(),
        transport,
        command,
        url,
        enabled,
    }
}

fn collect_json_mcp_servers(path: &Path, source: &str, out: &mut Vec<McpServerEntry>) {
    let Some(root) = read_json_file(path) else {
        return;
    };
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return;
    };
    for (name, value) in servers {
        out.push(mcp_entry_from_json(name, source, value));
    }
}

fn parse_toml_string_value(line: &str, key: &str) -> Option<String> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix(key)?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    if rest.starts_with('"') {
        return rest
            .trim_matches('"')
            .split('"')
            .next()
            .map(str::to_string)
            .filter(|value| !value.is_empty());
    }
    Some(rest.trim().to_string()).filter(|value| !value.is_empty())
}

fn parse_toml_bool_value(line: &str, key: &str) -> Option<bool> {
    parse_toml_string_value(line, key).and_then(|value| match value.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    })
}

fn load_codex_config_text() -> Option<String> {
    let home = home_dir()?;
    fs::read_to_string(home.join(".codex").join("config.toml")).ok()
}

fn load_codex_mcp_servers() -> Vec<McpServerEntry> {
    let Some(content) = load_codex_config_text() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut current: Option<McpServerEntry> = None;
    let mut in_nested_mcp_section = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[mcp_servers.") && trimmed.ends_with(']') {
            let name = trimmed
                .trim_start_matches("[mcp_servers.")
                .trim_end_matches(']')
                .trim_matches('"')
                .to_string();
            if name.contains('.') {
                in_nested_mcp_section = true;
                continue;
            }
            if let Some(entry) = current.take() {
                out.push(entry);
            }
            in_nested_mcp_section = false;
            current = Some(McpServerEntry {
                id: format!("codex:{name}"),
                name,
                source: "codex".to_string(),
                transport: "stdio".to_string(),
                command: None,
                url: None,
                enabled: true,
            });
            continue;
        }
        if trimmed.starts_with('[') {
            if let Some(entry) = current.take() {
                out.push(entry);
            }
            in_nested_mcp_section = false;
            continue;
        }
        if in_nested_mcp_section {
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(value) = parse_toml_string_value(trimmed, "type") {
            entry.transport = value;
        } else if let Some(value) = parse_toml_string_value(trimmed, "command") {
            entry.command = Some(value);
        } else if let Some(value) = parse_toml_string_value(trimmed, "url") {
            entry.url = Some(value);
            if entry.transport == "stdio" {
                entry.transport = "http".to_string();
            }
        } else if let Some(value) = parse_toml_bool_value(trimmed, "enabled") {
            entry.enabled = value;
        }
    }
    if let Some(entry) = current {
        out.push(entry);
    }
    out
}

fn load_user_mcp_servers() -> Vec<McpServerEntry> {
    let mut out = load_codex_mcp_servers();
    if let Some(home) = home_dir() {
        collect_json_mcp_servers(
            &home.join(".claude").join("settings.json"),
            "claude",
            &mut out,
        );
        collect_json_mcp_servers(
            &home.join(".claude").join("config.json"),
            "claude",
            &mut out,
        );
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn load_codex_projects() -> Vec<ProjectEntry> {
    let Some(content) = load_codex_config_text() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_trust: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[projects.") && trimmed.ends_with(']') {
            if let Some(path) = current_path.take() {
                out.push(project_entry_without_branch(path, current_trust.take()));
            }
            current_path = Some(
                trimmed
                    .trim_start_matches("[projects.")
                    .trim_end_matches(']')
                    .trim_matches('"')
                    .to_string(),
            );
            current_trust = None;
            continue;
        }
        if trimmed.starts_with('[') {
            if let Some(path) = current_path.take() {
                out.push(project_entry_without_branch(path, current_trust.take()));
            }
            continue;
        }
        if current_path.is_some() {
            if let Some(value) = parse_toml_string_value(trimmed, "trust_level") {
                current_trust = Some(value);
            }
        }
    }
    if let Some(path) = current_path {
        out.push(project_entry_without_branch(path, current_trust));
    }
    out
}

fn project_entry(path: String, trust_level: Option<String>) -> ProjectEntry {
    project_entry_inner(path, trust_level, true)
}

fn project_entry_without_branch(path: String, trust_level: Option<String>) -> ProjectEntry {
    project_entry_inner(path, trust_level, false)
}

fn project_entry_inner(path: String, trust_level: Option<String>, include_branch: bool) -> ProjectEntry {
    let path_buf = PathBuf::from(&path);
    let name = path_buf
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&path)
        .to_string();
    ProjectEntry {
        id: path.clone(),
        name,
        git_branch: if include_branch {
            read_git_branch(&path_buf)
        } else {
            None
        },
        path,
        trust_level,
    }
}

fn project_root_from_input(project_path: &str) -> Result<PathBuf, String> {
    let root = if project_path.trim().is_empty() {
        app_workspace()
    } else {
        PathBuf::from(project_path.trim())
    };
    let root = fs::canonicalize(&root).map_err(|error| format!("无法读取项目目录：{error}"))?;
    if !root.is_dir() {
        return Err("项目路径必须是文件夹".to_string());
    }
    Ok(root)
}

fn relative_path_is_safe(path: &Path) -> bool {
    path.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

fn display_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn resolve_project_child_path(
    project_path: &str,
    child_path: &str,
    allow_missing: bool,
) -> Result<(PathBuf, PathBuf, String), String> {
    let root = project_root_from_input(project_path)?;
    let trimmed = child_path.trim().trim_start_matches("./");
    let input = PathBuf::from(trimmed);
    if input.is_absolute() {
        let target = if allow_missing {
            input
        } else {
            fs::canonicalize(&input).map_err(|error| format!("无法读取路径：{error}"))?
        };
        let comparable = if target.exists() {
            fs::canonicalize(&target).map_err(|error| format!("无法读取路径：{error}"))?
        } else if let Some(parent) = target.parent() {
            let parent =
                fs::canonicalize(parent).map_err(|error| format!("无法读取父目录：{error}"))?;
            target
                .file_name()
                .map(|name| parent.join(name))
                .unwrap_or(parent)
        } else {
            target.clone()
        };
        if !comparable.starts_with(&root) {
            return Err("只能访问当前项目目录内的文件".to_string());
        }
        let relative = display_relative_path(&root, &target);
        return Ok((root, target, relative));
    }

    if !relative_path_is_safe(&input) {
        return Err("路径不能包含 .. 或跨出项目目录".to_string());
    }
    let target = root.join(input);
    if !allow_missing && !target.exists() {
        return Err("路径不存在".to_string());
    }
    let comparable = if target.exists() {
        fs::canonicalize(&target).map_err(|error| format!("无法读取路径：{error}"))?
    } else if let Some(parent) = target.parent() {
        let parent =
            fs::canonicalize(parent).map_err(|error| format!("无法读取父目录：{error}"))?;
        target
            .file_name()
            .map(|name| parent.join(name))
            .unwrap_or(parent)
    } else {
        target.clone()
    };
    if !comparable.starts_with(&root) {
        return Err("只能访问当前项目目录内的文件".to_string());
    }
    let relative = display_relative_path(&root, &target);
    Ok((root, target, relative))
}

fn metadata_modified_millis(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
}

fn should_skip_project_file_entry(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".git"
            | ".next"
            | ".nuxt"
            | ".cache"
            | ".turbo"
            | ".venv"
            | "node_modules"
            | "dist"
            | "build"
            | "target"
            | "coverage"
            | "vendor"
    )
}

fn fuzzy_file_match(path: &str, query: &str) -> bool {
    let normalized_path = path.to_lowercase();
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return true;
    }
    if normalized_path.contains(&normalized_query) {
        return true;
    }

    let mut chars = normalized_query.chars();
    let mut current = chars.next();
    if current.is_none() {
        return true;
    }
    for item in normalized_path.chars() {
        if Some(item) == current {
            current = chars.next();
            if current.is_none() {
                return true;
            }
        }
    }
    false
}

fn collect_project_files(
    root: &Path,
    dir: &Path,
    query: &str,
    visited: &mut usize,
    out: &mut Vec<ProjectFileEntry>,
) {
    if *visited >= 2_000 || out.len() >= 50 {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        if *visited >= 2_000 || out.len() >= 50 {
            return;
        }
        let path = entry.path();
        if should_skip_project_file_entry(&path) {
            continue;
        }
        if path.is_dir() {
            collect_project_files(root, &path, query, visited, out);
            continue;
        }
        if !path.is_file() {
            continue;
        }

        *visited += 1;
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if !fuzzy_file_match(&relative, query) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&relative)
            .to_string();
        out.push(ProjectFileEntry {
            path: relative,
            name,
        });
    }
}

fn load_spark_user_profile(config: &Value) -> SparkUserProfile {
    let account = config.get("oauthAccount").and_then(Value::as_object);
    let logged_in = account.is_some()
        || env_string(config, SPARK_AUTH_TOKEN_ENV_KEY).is_some()
        || env_string(config, SPARK_REFRESH_TOKEN_ENV_KEY).is_some();

    SparkUserProfile {
        logged_in,
        id: account.and_then(|item| value_string(item.get("accountUuid"))),
        name: account.and_then(|item| value_string(item.get("displayName"))),
        email: account.and_then(|item| value_string(item.get("emailAddress"))),
        avatar_url: account.and_then(|item| value_string(item.get("avatarUrl"))),
        organization_id: account.and_then(|item| value_string(item.get("organizationUuid"))),
        organization_name: account.and_then(|item| value_string(item.get("organizationName"))),
        billing_type: account.and_then(|item| value_string(item.get("billingType"))),
        account_created_at: account.and_then(|item| value_string(item.get("accountCreatedAt"))),
    }
}

fn clear_spark_login_state() -> Result<Value, String> {
    let mut config = read_spark_config();
    if let Some(env_root) = config.get_mut("env").and_then(Value::as_object_mut) {
        env_root.remove(SPARK_AUTH_TOKEN_ENV_KEY);
        env_root.remove(SPARK_REFRESH_TOKEN_ENV_KEY);
        env_root.remove(SPARK_BASE_URL_ENV_KEY);
    }
    if let Some(root) = config.as_object_mut() {
        root.remove("oauthAccount");
    }
    write_spark_config(&config)?;
    Ok(config)
}

fn load_remote_device_binding(app: &tauri::AppHandle, config: &Value) -> RemoteDeviceBinding {
    let install_id = env_string(config, SPARK_INSTALL_ID_ENV_KEY);
    let device_id = env_string(config, SPARK_DEVICE_ID_ENV_KEY);
    let remote_client = load_remote_client_config(app);
    let has_client_token = remote_client
        .client_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    let configured = install_id.is_some() && device_id.is_some();
    let bound = has_client_token;
    let status = if bound {
        "已绑定".to_string()
    } else if configured {
        "待输入绑定码".to_string()
    } else {
        "未绑定".to_string()
    };

    RemoteDeviceBinding {
        configured,
        bound,
        install_id,
        device_id,
        binding_id: remote_client.binding_id,
        client_name: remote_client.client_name,
        package_name: SPARK_PACKAGE_NAME.to_string(),
        app_version: SPARK_APP_VERSION.to_string(),
        status,
    }
}

fn load_preferences(config: &Value) -> AppPreferences {
    AppPreferences {
        permission_mode: normalize_permission_mode(
            &value_string(config.get("permissionMode"))
                .or_else(|| value_string(config.get("backendPermissionMode")))
                .unwrap_or_else(|| "limited".to_string()),
        ),
        remote_control_at_startup: config
            .get("remoteControlAtStartup")
            .and_then(Value::as_bool),
        auto_compact_enabled: config_bool(config, "autoCompactEnabled", true),
        show_turn_duration: config_bool(config, "showTurnDuration", true),
        terminal_progress_bar_enabled: config_bool(config, "terminalProgressBarEnabled", true),
        file_checkpointing_enabled: config_bool(config, "fileCheckpointingEnabled", true),
        respect_gitignore: config_bool(config, "respectGitignore", true),
        copy_full_response: config_bool(config, "copyFullResponse", false),
        auto_connect_ide: config_bool(config, "autoConnectIde", false),
        auto_install_ide_extension: config_bool(config, "autoInstallIdeExtension", true),
    }
}

fn set_bool(root: &mut Map<String, Value>, key: &str, value: bool) {
    root.insert(key.to_string(), Value::Bool(value));
}

fn load_remote_config(_app: &tauri::AppHandle) -> RemoteConfig {
    default_remote_config()
}

fn persist_remote_config(app: &tauri::AppHandle, config: &RemoteConfig) -> Result<(), String> {
    let path = config_path(app, "remote.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("无法序列化 Remote 配置：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存 Remote 配置：{error}"))
}

fn load_remote_client_config(app: &tauri::AppHandle) -> RemoteClientConfig {
    let Ok(path) = config_path(app, "remote-client.json") else {
        return RemoteClientConfig::default();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return RemoteClientConfig::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn persist_remote_client_config(
    app: &tauri::AppHandle,
    config: &RemoteClientConfig,
) -> Result<(), String> {
    let path = config_path(app, "remote-client.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("无法序列化 Remote 绑定：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存 Remote 绑定：{error}"))
}

fn remove_remote_client_config(app: &tauri::AppHandle) -> Result<(), String> {
    let path = config_path(app, "remote-client.json")?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法清除 Remote 绑定：{error}"))?;
    }
    Ok(())
}

fn load_model_config(app: &tauri::AppHandle) -> ModelConfig {
    let default = model_config_with_options(default_model_options());
    let Ok(path) = config_path(app, "model.json") else {
        return load_user_model_config(default);
    };
    let Ok(content) = fs::read_to_string(path) else {
        return load_user_model_config(default);
    };
    let mut config: ModelConfig = serde_json::from_str(&content).unwrap_or(default);
    if config.selected.trim().is_empty() {
        config.selected = load_user_model_config(default_model_config()).selected;
    }
    if config.options.is_empty() {
        config
    } else {
        ensure_selected_model_option(config)
    }
}

fn load_user_model_config(mut default: ModelConfig) -> ModelConfig {
    let Some(home) = home_dir() else {
        return default;
    };

    if let Some(value) = read_json_file(&home.join(".claude").join("settings.json"))
        .and_then(|config| value_string(config.get("model")))
    {
        default.selected = normalize_model_alias(value);
        return default;
    }

    if let Some(content) = load_codex_config_text() {
        for line in content.lines() {
            if let Some(value) = parse_toml_string_value(line, "model") {
                default.selected = normalize_model_alias(value);
                return default;
            }
        }
    }

    default
}

fn normalize_model_alias(value: String) -> String {
    let options = default_model_options();
    if options.is_empty() {
        return value;
    }
    if options.iter().any(|option| option.id == value) {
        return value;
    }
    let lower = value.to_lowercase();
    if lower.contains("opus") {
        "opus".to_string()
    } else if lower.contains("haiku") {
        "haiku".to_string()
    } else if lower.contains("sonnet") {
        "sonnet".to_string()
    } else {
        value
    }
}

fn persist_model_config(app: &tauri::AppHandle, config: &ModelConfig) -> Result<(), String> {
    let path = config_path(app, "model.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("无法序列化模型配置：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存模型配置：{error}"))
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    index += 3;
                } else {
                    out.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|part| {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if url_decode(name) == key {
            Some(url_decode(value))
        } else {
            None
        }
    })
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn write_oauth_html(stream: &mut TcpStream, title: &str, body: &str) {
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}}main{{width:min(420px,calc(100vw - 32px));background:#fff;border:1px solid #d9e0ea;border-radius:12px;padding:26px;box-shadow:0 18px 45px rgba(23,32,51,.10)}}h1{{margin:0 0 8px;font-size:22px}}p{{margin:0;color:#5d6a7c;line-height:1.5}}</style></head><body><main><h1>{}</h1><p>{}</p></main></body></html>",
        escape_html(title),
        escape_html(title),
        escape_html(body),
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.as_bytes().len(),
        html,
    );
    let _ = stream.write_all(response.as_bytes());
}

fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = ProcessCommand::new("open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = ProcessCommand::new("cmd");
        command.arg("/C").arg("start").arg("").arg(url);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = ProcessCommand::new("xdg-open");
        command.arg(url);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开浏览器，请手动访问：{url}\n{error}"))
}

fn curl_json(args: &[String]) -> Result<Value, String> {
    let output = ProcessCommand::new("curl")
        .args(args)
        .output()
        .map_err(|error| format!("无法调用 curl：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            "网络请求失败".to_string()
        } else {
            stderr
        });
    }

    let (body, status) = stdout
        .rsplit_once('\n')
        .ok_or_else(|| "后端响应格式无效".to_string())?;
    let status_code = status.trim().parse::<u16>().unwrap_or(0);
    if !(200..300).contains(&status_code) {
        let detail = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|value| {
                value_string(value.get("detail"))
                    .or_else(|| value_string(value.get("message")))
                    .or_else(|| value_string(value.get("error")))
            })
            .unwrap_or_else(|| body.trim().to_string());
        return Err(format!("后端返回 {status_code}：{detail}"));
    }
    serde_json::from_str(body).map_err(|error| format!("无法解析后端响应：{error}"))
}

fn build_oauth_callback_url(port: u16) -> String {
    format!("http://localhost:{port}{OAUTH_CALLBACK_PATH}")
}

fn build_spark_oauth_url(
    base_url: &str,
    redirect_uri: &str,
    state: &str,
    install_id: &str,
    device_id: &str,
) -> String {
    format!(
        "{base_url}{SPARK_OAUTH_AUTHORIZE_PATH}?redirect_uri={}&response_mode=query&install_id={}&device_id={}&package_name={}&cert_sha256={}&app_version={}&state={}",
        url_encode(redirect_uri),
        url_encode(install_id),
        url_encode(device_id),
        url_encode(SPARK_PACKAGE_NAME),
        url_encode(SPARK_CERT_SHA256),
        url_encode(SPARK_APP_VERSION),
        url_encode(state),
    )
}

fn wait_for_oauth_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法设置 OAuth 回调监听：{error}"))?;
    let deadline = Instant::now() + Duration::from_secs(10 * 60);

    loop {
        if Instant::now() >= deadline {
            return Err("等待 OAuth 回调超时，请重新运行 /login".to_string());
        }

        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buffer = [0_u8; 8192];
                let size = stream
                    .read(&mut buffer)
                    .map_err(|error| format!("读取 OAuth 回调失败：{error}"))?;
                let request = String::from_utf8_lossy(&buffer[..size]);
                let request_line = request.lines().next().unwrap_or_default();
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let (route, query) = path.split_once('?').unwrap_or((path, ""));

                if route == "/favicon.ico" {
                    let _ = stream.write_all(
                        b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                }

                if route != OAUTH_CALLBACK_PATH {
                    write_oauth_html(
                        &mut stream,
                        "等待 Spark 授权",
                        "请在后端授权页面完成登录。",
                    );
                    continue;
                }

                if let Some(error) = query_value(query, "error") {
                    let message = query_value(query, "error_description").unwrap_or(error);
                    write_oauth_html(&mut stream, "登录失败", &message);
                    return Err(message);
                }

                let state =
                    query_value(query, "state").ok_or_else(|| "授权回调缺少 state".to_string())?;
                if state != expected_state {
                    write_oauth_html(&mut stream, "登录失败", "授权状态校验失败，请重新运行 /login。");
                    return Err("授权状态校验失败，请重新运行 /login".to_string());
                }

                let refresh_token = query_value(query, "refresh_token")
                    .ok_or_else(|| "授权回调里没有刷新令牌".to_string())?;
                write_oauth_html(
                    &mut stream,
                    "登录成功",
                    "可以关闭这个页面，回到 Spark Code。",
                );
                return Ok(refresh_token);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("OAuth 回调监听失败：{error}")),
        }
    }
}

fn exchange_android_refresh_token(
    refresh_token: &str,
    install_id: &str,
    device_id: &str,
) -> Result<Value, String> {
    let body = serde_json::json!({
        "refresh_token": refresh_token,
        "install_id": install_id,
        "device_id": device_id,
        "package_name": SPARK_PACKAGE_NAME,
        "cert_sha256": SPARK_CERT_SHA256,
        "app_version": SPARK_APP_VERSION,
    });
    let body_text = serde_json::to_string(&body)
        .map_err(|error| format!("无法序列化登录请求：{error}"))?;
    let url = format!("{FIXED_BACKEND_URL}{SPARK_AUTH_REFRESH_PATH}");
    let value = curl_json(&[
        "-sS".to_string(),
        "--max-time".to_string(),
        "20".to_string(),
        "-w".to_string(),
        "\n%{http_code}".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
        "-d".to_string(),
        body_text,
        url,
    ])?;
    if value_string(value.get("access_token"))
        .or_else(|| value_string(value.get("accessToken")))
        .is_none()
    {
        return Err("后端没有返回访问令牌".to_string());
    }
    if value_string(value.get("refresh_token"))
        .or_else(|| value_string(value.get("refreshToken")))
        .is_none()
    {
        return Err("后端没有返回刷新令牌".to_string());
    }
    Ok(value)
}

fn fetch_spark_profile(access_token: &str) -> Option<Value> {
    for path in [
        "/api/v1/android/me",
        "/api/v1/android/user",
        "/api/v1/android/profile",
        "/api/v1/android/account",
        SPARK_OAUTH_USERINFO_PATH,
    ] {
        let url = format!("{FIXED_BACKEND_URL}{path}");
        if let Ok(value) = curl_json(&[
            "-sS".to_string(),
            "--max-time".to_string(),
            "5".to_string(),
            "-w".to_string(),
            "\n%{http_code}".to_string(),
            "-H".to_string(),
            format!("Authorization: Bearer {access_token}"),
            url,
        ]) {
            return Some(value);
        }
    }
    None
}

fn nested_value<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn nested_string(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths
        .iter()
        .find_map(|path| value_string(nested_value(value, path)))
}

fn refresh_spark_user_profile(config: &Value) -> SparkUserProfile {
    let Some(auth_token) = env_string(config, SPARK_AUTH_TOKEN_ENV_KEY) else {
        return load_spark_user_profile(config);
    };
    let Some(profile) = fetch_spark_profile(&auth_token) else {
        return load_spark_user_profile(config);
    };
    save_spark_login(
        serde_json::json!({ "access_token": auth_token }),
        Some(profile),
    )
    .unwrap_or_else(|_| load_spark_user_profile(config))
}

fn line_change_counts(before: &str, after: &str) -> (u32, u32) {
    let before_lines: Vec<&str> = before.lines().collect();
    let after_lines: Vec<&str> = after.lines().collect();
    if before_lines.len() > 2_000 || after_lines.len() > 2_000 {
        return if after_lines.len() >= before_lines.len() {
            ((after_lines.len() - before_lines.len()) as u32, 0)
        } else {
            (0, (before_lines.len() - after_lines.len()) as u32)
        };
    }

    let mut previous = vec![0u16; after_lines.len() + 1];
    let mut current = vec![0u16; after_lines.len() + 1];
    for before_line in before_lines.iter() {
        for (index, after_line) in after_lines.iter().enumerate() {
            current[index + 1] = if before_line == after_line {
                previous[index].saturating_add(1)
            } else {
                previous[index + 1].max(current[index])
            };
        }
        std::mem::swap(&mut previous, &mut current);
        current.fill(0);
    }
    let common = previous[after_lines.len()] as usize;
    (
        after_lines.len().saturating_sub(common) as u32,
        before_lines.len().saturating_sub(common) as u32,
    )
}

fn load_recent_changes(app: &tauri::AppHandle) -> Vec<RecentChange> {
    let Ok(path) = config_path(app, "changes.json") else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut changes: Vec<RecentChange> = serde_json::from_str(&content).unwrap_or_default();
    for change in changes.iter_mut() {
        let Some(before_content) = change.before_content.as_deref() else {
            continue;
        };
        let Ok(after_content) = fs::read_to_string(&change.path) else {
            continue;
        };
        let (added, removed) = line_change_counts(before_content, &after_content);
        change.added_lines = added;
        change.removed_lines = removed;
    }
    changes
}

fn persist_recent_changes(app: &tauri::AppHandle, changes: &[RecentChange]) -> Result<(), String> {
    let path = config_path(app, "changes.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(changes)
        .map_err(|error| format!("无法序列化近期更改：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存近期更改：{error}"))
}

fn compact_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{prefix}{:x}", now % 0xffff_ffff)
}

fn fallback_session_uuid() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id() as u128;
    let count = FALLBACK_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed) as u128;
    let hex = format!("{:032x}", now ^ (pid << 64) ^ count);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn app_log(message: impl AsRef<str>) {
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/sparkcode-app.log")
    {
        let _ = writeln!(file, "{}", message.as_ref());
    }
}

fn path_has_spark_source(path: &Path) -> bool {
    path.join("src")
        .join("server")
        .join("server-entry.ts")
        .is_file()
        && path.join("package.json").is_file()
}

fn find_spark_code_root() -> Option<PathBuf> {
    if let Some(path) = env::var_os("SPARK_CODE_ROOT").map(PathBuf::from) {
        if path_has_spark_source(&path) {
            return Some(path);
        }
    }

    if let Some(path) = env::var_os(BUNDLED_BACKEND_ROOT_ENV_KEY).map(PathBuf::from) {
        if is_app_resource_backend_archive(&path) {
            if let Some(root) = stage_bundled_backend_archive(&path) {
                return Some(root);
            }
        }
        if path_has_spark_source(&path) {
            return Some(path);
        }
    }

    let mut starts = Vec::new();
    if let Ok(path) = env::current_dir() {
        starts.push(path);
    }
    if let Ok(path) = env::current_exe() {
        if let Some(parent) = path.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));

    for start in starts {
        for candidate in start.ancestors() {
            if path_has_spark_source(candidate) {
                return Some(
                    fs::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf()),
                );
            }
        }
    }

    None
}

fn bundled_bun_for_root(root: &Path) -> Option<PathBuf> {
    let candidate = root.join("runtime").join("bun");
    candidate.is_file().then_some(candidate)
}

fn is_app_resource_backend(path: &Path) -> bool {
    path.to_string_lossy()
        .contains(".app/Contents/Resources/spark-code-backend")
}

fn is_app_resource_backend_archive(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("spark-code-backend.tar.gz")
        && path
            .to_string_lossy()
            .contains(".app/Contents/Resources/spark-code-backend.tar.gz")
}

fn is_staged_backend_path(path: &Path) -> bool {
    path.to_string_lossy().contains("/.sparkc/backend/")
}

fn is_internal_backend_path(path: &Path) -> bool {
    is_app_resource_backend(path) || is_staged_backend_path(path)
}

fn copy_backend_resource(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| format!("无法清理后端缓存：{error}"))?;
    }
    fs::create_dir_all(target).map_err(|error| format!("无法创建后端缓存目录：{error}"))?;

    let source_contents = source.join(".");
    let status = ProcessCommand::new("/bin/cp")
        .arg("-R")
        .arg(&source_contents)
        .arg(target)
        .status()
        .map_err(|error| format!("无法复制内置后端：{error}"))?;
    if !status.success() {
        return Err(format!("复制内置后端失败：{status}"));
    }
    Ok(())
}

fn backend_stage_target() -> Option<PathBuf> {
    home_dir().map(|home| {
        home.join(".sparkc")
            .join("backend")
            .join(env!("CARGO_PKG_VERSION"))
    })
}

fn temp_backend_stage_dir(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("backend");
    target.with_file_name(format!("{name}.tmp-{}", std::process::id()))
}

fn archive_stamp_text(archive: &Path) -> String {
    let metadata = fs::metadata(archive).ok();
    let size = metadata
        .as_ref()
        .map(|value| value.len())
        .unwrap_or_default();
    let modified = metadata
        .and_then(|value| value.modified().ok())
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or_default();
    format!(
        "archive={}\nsize={size}\nmodified={modified}",
        archive.display()
    )
}

fn extract_backend_archive(archive: &Path, target: &Path) -> Result<(), String> {
    let tmp = temp_backend_stage_dir(target);
    if tmp.exists() {
        fs::remove_dir_all(&tmp).map_err(|error| format!("无法清理后端缓存：{error}"))?;
    }
    fs::create_dir_all(&tmp).map_err(|error| format!("无法创建后端缓存目录：{error}"))?;

    let status = ProcessCommand::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(&tmp)
        .status()
        .map_err(|error| format!("无法解包内置后端：{error}"))?;
    if !status.success() {
        return Err(format!("解包内置后端失败：{status}"));
    }

    let extracted = tmp.join("spark-code-backend");
    if !path_has_spark_source(&extracted) {
        let _ = fs::remove_dir_all(&tmp);
        return Err("内置后端资源不完整".to_string());
    }

    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| format!("无法替换后端缓存：{error}"))?;
    }
    fs::rename(&extracted, target).map_err(|error| format!("无法安装后端缓存：{error}"))?;
    let _ = fs::remove_dir_all(&tmp);
    Ok(())
}

fn stage_bundled_backend_archive(archive: &Path) -> Option<PathBuf> {
    let target = backend_stage_target()?;
    let stamp = target.join(".sparkcode-backend-source");
    let source_text = archive_stamp_text(archive);
    let target_ready = path_has_spark_source(&target)
        && bundled_bun_for_root(&target).is_some()
        && fs::read_to_string(&stamp)
            .map(|value| value == source_text)
            .unwrap_or(false);

    if target_ready {
        return Some(target);
    }

    app_log(format!(
        "backend:stage-extract archive={} target={}",
        archive.display(),
        target.display()
    ));
    match extract_backend_archive(archive, &target) {
        Ok(()) => {
            let _ = fs::write(&stamp, source_text);
            Some(target)
        }
        Err(error) => {
            app_log(format!("backend:stage-extract-error {error}"));
            None
        }
    }
}

fn stage_bundled_backend_root(root: &Path) -> PathBuf {
    if cfg!(debug_assertions) || !is_app_resource_backend(root) {
        return root.to_path_buf();
    }

    let Some(target) = backend_stage_target() else {
        return root.to_path_buf();
    };
    let stamp = target.join(".sparkcode-backend-source");
    let source_manifest =
        fs::read_to_string(root.join("backend-resource.json")).unwrap_or_else(|_| String::new());
    let source_text = format!("{}\n{}", root.display(), source_manifest);
    let target_ready = path_has_spark_source(&target)
        && bundled_bun_for_root(&target).is_some()
        && fs::read_to_string(&stamp)
            .map(|value| value == source_text)
            .unwrap_or(false);

    if target_ready {
        return target;
    }

    let tmp = target.with_extension(format!("tmp-{}", std::process::id()));
    app_log(format!(
        "backend:stage-copy source={} target={}",
        root.display(),
        target.display()
    ));
    match copy_backend_resource(root, &tmp) {
        Ok(()) => {
            if target.exists() {
                let _ = fs::remove_dir_all(&target);
            }
            if let Err(error) = fs::rename(&tmp, &target) {
                app_log(format!("backend:stage-rename-error {error}"));
                let _ = fs::remove_dir_all(&tmp);
                return root.to_path_buf();
            }
            let _ = fs::write(&stamp, source_text);
            target
        }
        Err(error) => {
            app_log(format!("backend:stage-copy-error {error}"));
            let _ = fs::remove_dir_all(&tmp);
            root.to_path_buf()
        }
    }
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn open_log_stdio() -> Stdio {
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/sparkcode-app-backend.log")
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

fn backend_workspace() -> PathBuf {
    if let Some(workspace) = env::var_os("SPARK_CODE_WORKSPACE").map(PathBuf::from) {
        return fs::canonicalize(&workspace).unwrap_or(workspace);
    }

    if let Ok(current) = env::current_dir() {
        if !is_internal_backend_path(&current)
            && !is_privacy_scoped_user_path(&current)
            && current != Path::new("/")
        {
            return fs::canonicalize(&current).unwrap_or(current);
        }
    }

    let workspace = safe_default_workspace();
    fs::create_dir_all(&workspace).ok();
    fs::canonicalize(&workspace).unwrap_or(workspace)
}

fn safe_default_workspace() -> PathBuf {
    backend_cache_dir()
        .map(|path| path.join("workspace"))
        .unwrap_or_else(|| env::temp_dir().join("sparkcode-app-workspace"))
}

fn is_privacy_scoped_user_path(path: &Path) -> bool {
    let Some(home) = home_dir() else {
        return false;
    };
    for protected in ["Desktop", "Documents", "Downloads"] {
        if path.starts_with(home.join(protected)) {
            return true;
        }
    }
    false
}

fn app_workspace() -> PathBuf {
    if let Ok(active) = active_project_path().lock() {
        if let Some(path) = active.as_deref().filter(|value| !value.trim().is_empty()) {
            let path = PathBuf::from(path);
            return fs::canonicalize(&path).unwrap_or(path);
        }
    }
    backend_workspace()
}

#[tauri::command]
fn set_active_project_path(project_path: String) -> Result<Option<String>, String> {
    let trimmed = project_path.trim();
    let next = if trimmed.is_empty() || trimmed == "__sparkcode_no_project__" {
        None
    } else {
        let canonical =
            fs::canonicalize(trimmed).map_err(|error| format!("无法读取项目目录：{error}"))?;
        if !canonical.is_dir() {
            return Err("项目路径必须是文件夹".to_string());
        }
        Some(canonical.display().to_string())
    };

    let mut active = active_project_path()
        .lock()
        .map_err(|_| "当前项目状态暂时不可用".to_string())?;
    *active = next.clone();
    Ok(next)
}

fn backend_cache_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".sparkc").join("cache").join("sparkcode-app"))
}

fn configure_backend_environment(command: &mut ProcessCommand) {
    command
        .env_remove("XPC_SERVICE_NAME")
        .env_remove("XPC_FLAGS")
        .env_remove("__CFBundleIdentifier")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove(SPARK_AUTH_TOKEN_ENV_KEY)
        .env_remove(SPARK_REFRESH_TOKEN_ENV_KEY)
        .env_remove(SPARK_BASE_URL_ENV_KEY)
        .env("SPARK_CODE_BACKEND_LAUNCHED_BY", "sparkcode-app")
        .env("SPARK_CODE_REMOTE_BACKEND_URL", FIXED_BACKEND_URL);

    let spark_config = read_spark_config();
    if let Some(env_root) = spark_config.get("env").and_then(Value::as_object) {
        for key in [
            SPARK_AUTH_TOKEN_ENV_KEY,
            SPARK_REFRESH_TOKEN_ENV_KEY,
            SPARK_BASE_URL_ENV_KEY,
            SPARK_INSTALL_ID_ENV_KEY,
            SPARK_DEVICE_ID_ENV_KEY,
        ] {
            if let Some(value) = value_string(env_root.get(key)) {
                command.env(key, value);
            }
        }
    }

    if let Some(cache_dir) = backend_cache_dir() {
        let _ = fs::create_dir_all(&cache_dir);
        command
            .env("XDG_CACHE_HOME", &cache_dir)
            .env("BUN_INSTALL_CACHE_DIR", cache_dir.join("bun-install"))
            .env(
                "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
                cache_dir.join("bun-transpiler"),
            );
    }
}

fn describe_command(command: &ProcessCommand) -> String {
    let program = command.get_program().to_string_lossy();
    let args = command
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");
    let cwd = command
        .get_current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "-".to_string());
    format!("program={program} cwd={cwd} args={args}")
}

fn build_backend_command() -> Result<(ProcessCommand, String), String> {
    let workspace = app_workspace();

    if let Some(root) = find_spark_code_root() {
        let root = stage_bundled_backend_root(&root);
        let bun = bundled_bun_for_root(&root)
            .or_else(|| find_in_path("bun"))
            .unwrap_or_else(|| PathBuf::from("bun"));
        let mut command = ProcessCommand::new(bun);
        let entrypoint = root.join("src").join("server").join("server-entry.ts");
        command
            .current_dir(&root)
            .env("PWD", &root)
            .arg("--no-orphans")
            .arg("run")
            .arg(entrypoint)
            .arg("server")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("0")
            .arg("--auth-token")
            .arg(LOCAL_BACKEND_AUTH_TOKEN)
            .arg("--workspace")
            .arg(&workspace);
        return Ok((command, format!("source:{}", root.display())));
    }

    let sparkc = find_in_path("sparkc").unwrap_or_else(|| PathBuf::from("sparkc"));
    let mut command = ProcessCommand::new(sparkc);
    command
        .arg("server")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .arg("--auth-token")
        .arg(LOCAL_BACKEND_AUTH_TOKEN)
        .arg("--workspace")
        .arg(&workspace);
    Ok((command, "sparkc".to_string()))
}

fn backend_process() -> &'static Mutex<Option<Child>> {
    BACKEND_PROCESS.get_or_init(|| Mutex::new(None))
}

fn server_lock_path() -> Option<PathBuf> {
    home_dir().map(|home| {
        home.join(".sparkc")
            .join(format!("sparkcode-app-{}.lock", std::process::id()))
    })
}

fn app_pid_from_lock_path(path: &Path) -> Option<u32> {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("sparkcode-app-"))
        .and_then(|name| name.strip_suffix(".lock"))
        .and_then(|name| name.parse::<u32>().ok())
}

fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }

    #[cfg(target_family = "unix")]
    {
        ProcessCommand::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(not(target_family = "unix"))]
    {
        false
    }
}

fn terminate_process(pid: u32, reason: &str) {
    if pid == 0 || pid == std::process::id() {
        return;
    }

    #[cfg(target_family = "unix")]
    {
        let _ = ProcessCommand::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
        thread::sleep(Duration::from_millis(120));
        if process_is_alive(pid) {
            let _ = ProcessCommand::new("kill")
                .arg("-KILL")
                .arg(pid.to_string())
                .status();
        }
        app_log(format!(
            "backend:terminated-stale pid={pid} reason={reason}"
        ));
    }
}

fn cleanup_stale_app_backends() {
    let Some(home) = home_dir() else {
        return;
    };
    let dir = home.join(".sparkc");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let current_app_pid = std::process::id();

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(app_pid) = app_pid_from_lock_path(&path) else {
            continue;
        };
        if app_pid == current_app_pid {
            continue;
        }
        if process_is_alive(app_pid) {
            continue;
        }

        let backend_pid = read_json_file(&path).and_then(|lock| value_u32(lock.get("pid")));
        if let Some(pid) = backend_pid {
            if process_is_alive(pid) {
                terminate_process(pid, "dead-app-lock");
            }
        }
        if fs::remove_file(&path).is_ok() {
            app_log(format!("backend:removed-stale-lock {}", path.display()));
        }
    }
}

fn read_local_backend_url() -> Option<String> {
    let path = server_lock_path()?;
    let lock = read_json_file(&path)?;
    value_string(lock.get("httpUrl"))
}

fn wait_for_local_backend_url() -> Option<String> {
    for _ in 0..30 {
        if let Some(url) = read_local_backend_url() {
            if url.starts_with("http://") {
                return Some(url);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

fn parse_local_http_url(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "本地后端地址格式无效".to_string())?;
    let host_port = rest.split('/').next().unwrap_or(rest);
    let (host, port) = host_port
        .rsplit_once(':')
        .ok_or_else(|| "本地后端端口缺失".to_string())?;
    let port = port
        .parse::<u16>()
        .map_err(|_| "本地后端端口无效".to_string())?;
    Ok((host.to_string(), port))
}

fn local_http_response_complete(response: &[u8]) -> bool {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let content_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            return value.trim().parse::<usize>().ok();
        }
        None
    });
    match content_length {
        Some(length) => response.len().saturating_sub(header_end + 4) >= length,
        None => false,
    }
}

fn is_transient_http_read_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::TimedOut
    ) || matches!(error.raw_os_error(), Some(11 | 35))
}

fn read_local_http_response(stream: &mut TcpStream) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_millis(15_000);
    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];

    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if local_http_response_complete(&response) {
                    break;
                }
            }
            Err(error) if is_transient_http_read_error(&error) => {
                if local_http_response_complete(&response) {
                    break;
                }
                if Instant::now() >= deadline {
                    if response.is_empty() {
                        return Err("本地后端响应超时，请稍后重试".to_string());
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("无法读取后端响应：{error}")),
        }
    }

    String::from_utf8(response).map_err(|error| format!("后端响应不是有效 UTF-8：{error}"))
}

fn post_local_backend_json(path: &str, body: &Value) -> Result<Value, String> {
    let url =
        wait_for_local_backend_url().ok_or_else(|| "本地 Spark Code 后端尚未就绪".to_string())?;
    let (host, port) = parse_local_http_url(&url)?;
    let body_text =
        serde_json::to_string(body).map_err(|error| format!("无法序列化请求：{error}"))?;
    let address = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析本地后端地址：{error}"))?
        .next()
        .ok_or_else(|| "本地后端地址无效".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(1_800))
        .map_err(|error| format!("无法连接本地后端：{error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1_500)));
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {LOCAL_BACKEND_AUTH_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_text}",
        body_text.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("无法写入后端请求：{error}"))?;
    let response = read_local_http_response(&mut stream)?;
    let (_, payload) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "本地后端响应格式无效".to_string())?;
    let status_line = response.lines().next().unwrap_or_default().to_string();
    let value: Value =
        serde_json::from_str(payload).map_err(|error| format!("无法解析后端响应：{error}"))?;
    if !status_line.contains(" 200 ") {
        let message = value_string(value.get("error"))
            .map(|error| format!("{status_line}: {error}"))
            .unwrap_or(status_line);
        return Err(message);
    }
    Ok(value)
}

fn canonical_project_path(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn create_app_session(title: String, project_path: String, remote: bool) -> Session {
    Session {
        id: fallback_session_uuid(),
        title,
        tokens: 0,
        context_used: 0,
        context_limit: 1_000_000,
        project_path,
        remote,
    }
}

fn normalized_session_project_key(project_path: &str) -> String {
    let normalized = project_path
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if normalized.is_empty() {
        "default".to_string()
    } else {
        normalized
    }
}

fn is_empty_current_session(session: &Session) -> bool {
    session.title.trim() == "当前会话" && session.tokens == 0 && session.context_used == 0
}

fn prune_empty_current_sessions(sessions: &mut Vec<Session>) {
    let mut seen_projects = HashSet::new();
    sessions.retain(|session| {
        if !is_empty_current_session(session) {
            return true;
        }
        seen_projects.insert(normalized_session_project_key(&session.project_path))
    });
}

fn load_slash_commands(project_path: &str) -> Vec<SlashCommandEntry> {
    start_spark_backend();
    let body = serde_json::json!({
        "cwd": project_path,
    });
    match post_local_backend_json("/slash-commands", &body) {
        Ok(value) => {
            serde_json::from_value::<Vec<SlashCommandEntry>>(value).unwrap_or_else(|error| {
                app_log(format!("backend:slash-command-parse-error {error}"));
                Vec::new()
            })
        }
        Err(error) => {
            app_log(format!("backend:slash-command-load-error {error}"));
            Vec::new()
        }
    }
}

fn load_tool_catalog(permission_mode: &str) -> Vec<ToolEntry> {
    start_spark_backend();
    let body = serde_json::json!({
        "permission_mode": backend_permission_mode(permission_mode),
    });
    match post_local_backend_json("/tools", &body) {
        Ok(value) => serde_json::from_value::<Vec<ToolEntry>>(value).unwrap_or_else(|error| {
            app_log(format!("backend:tool-catalog-parse-error {error}"));
            Vec::new()
        }),
        Err(error) => {
            app_log(format!("backend:tool-catalog-load-error {error}"));
            Vec::new()
        }
    }
}

fn backend_runtime_snapshot() -> BackendRuntime {
    BackendRuntime {
        local_url: read_local_backend_url(),
        auth_token: LOCAL_BACKEND_AUTH_TOKEN.to_string(),
        streaming_enabled: true,
        context_limit: 1_000_000,
    }
}

#[tauri::command]
fn ensure_local_backend() -> BackendRuntime {
    start_spark_backend();
    let _ = wait_for_local_backend_url();
    backend_runtime_snapshot()
}

#[tauri::command]
fn get_slash_commands(project_path: String) -> Vec<SlashCommandEntry> {
    let project_path = if project_path.trim().is_empty() {
        canonical_project_path(app_workspace())
    } else {
        canonical_project_path(project_path.trim())
    };
    load_slash_commands(&project_path)
}

#[tauri::command]
fn get_tool_catalog(permission_mode: String) -> Vec<ToolEntry> {
    load_tool_catalog(&permission_mode)
}

#[tauri::command]
fn run_local_command(
    name: String,
    args: String,
    project_path: Option<String>,
) -> Result<String, String> {
    start_spark_backend();
    let cwd = project_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(canonical_project_path)
        .unwrap_or_else(|| canonical_project_path(app_workspace()));
    let body = serde_json::json!({
        "name": name.trim(),
        "args": args.trim(),
        "cwd": cwd,
    });
    let value = post_local_backend_json("/local-command", &body)?;
    Ok(value_string(value.get("content")).unwrap_or_else(|| "已完成".to_string()))
}

#[tauri::command]
fn submit_feedback(
    description: String,
    project_path: Option<String>,
    messages: Option<Vec<ChatMessage>>,
) -> Result<String, String> {
    start_spark_backend();
    let cwd = project_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(canonical_project_path)
        .unwrap_or_else(|| canonical_project_path(app_workspace()));
    let body = serde_json::json!({
        "description": description.trim(),
        "cwd": cwd,
        "messages": messages.unwrap_or_default(),
    });
    let value = post_local_backend_json("/feedback", &body)?;
    Ok(value_string(value.get("feedback_id")).unwrap_or_else(|| "unknown".to_string()))
}

fn ensure_default_sessions(remote: bool) -> Vec<Session> {
    let project_path = canonical_project_path(app_workspace());
    let Ok(mut sessions) = app_sessions().lock() else {
        return vec![create_app_session(
            "当前会话".to_string(),
            project_path,
            remote,
        )];
    };

    if sessions.is_empty() {
        sessions.push(create_app_session(
            "当前会话".to_string(),
            project_path.clone(),
            remote,
        ));
    }

    if !sessions
        .iter()
        .any(|session| session.project_path == project_path)
    {
        sessions.push(create_app_session(
            "当前会话".to_string(),
            project_path,
            remote,
        ));
    }

    prune_empty_current_sessions(&mut sessions);
    sessions.clone()
}

fn start_spark_backend() {
    STALE_BACKEND_CLEANUP_DONE.get_or_init(cleanup_stale_app_backends);

    let mut guard = match backend_process().lock() {
        Ok(guard) => guard,
        Err(_) => {
            app_log("backend:lock-unavailable");
            return;
        }
    };

    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                app_log(format!("backend:already-running pid={}", child.id()));
                return;
            }
            Ok(Some(status)) => {
                app_log(format!("backend:previous-exited status={status}"));
                *guard = None;
            }
            Err(error) => {
                app_log(format!("backend:try-wait-error {error}"));
                *guard = None;
            }
        }
    }

    let (mut command, source) = match build_backend_command() {
        Ok(value) => value,
        Err(error) => {
            app_log(format!("backend:command-error {error}"));
            return;
        }
    };

    command
        .env("SPARK_CODE_BACKEND_LAUNCHED_BY", "sparkcode-app")
        .env("SPARK_CODE_REMOTE_BACKEND_URL", FIXED_BACKEND_URL)
        .stdin(Stdio::null())
        .stdout(open_log_stdio())
        .stderr(open_log_stdio());
    configure_backend_environment(&mut command);
    if let Some(lock_path) = server_lock_path() {
        let _ = fs::remove_file(&lock_path);
        app_log(format!("backend:lock-path {}", lock_path.display()));
        command.env("SPARK_CODE_SERVER_LOCK_PATH", lock_path);
    }
    app_log(format!("backend:command {}", describe_command(&command)));

    match command.spawn() {
        Ok(mut child) => {
            thread::sleep(Duration::from_millis(150));
            match child.try_wait() {
                Ok(Some(status)) => {
                    app_log(format!(
                        "backend:exited-after-spawn status={status} {source}"
                    ));
                }
                Ok(None) => {
                    app_log(format!("backend:spawned pid={} {source}", child.id()));
                    *guard = Some(child);
                }
                Err(error) => {
                    app_log(format!("backend:spawn-check-error {error} {source}"));
                    *guard = Some(child);
                }
            }
        }
        Err(error) => {
            app_log(format!("backend:spawn-error {error}"));
        }
    }
}

fn start_spark_backend_async() {
    thread::spawn(start_spark_backend);
}

fn stop_spark_backend() {
    let Some(process) = BACKEND_PROCESS.get() else {
        return;
    };
    let Ok(mut guard) = process.lock() else {
        return;
    };
    let Some(mut child) = guard.take() else {
        return;
    };

    app_log(format!("backend:stopping pid={}", child.id()));
    let _ = child.kill();
    let _ = child.wait();
    if let Some(lock_path) = server_lock_path() {
        let _ = fs::remove_file(lock_path);
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }

    let window_labels = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<Vec<_>>()
        .join(",");
    app_log(format!("window:available [{window_labels}]"));

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: 1180.0,
            height: 760.0,
        }));
        let _ = window.center();
        match window.show() {
            Ok(_) => app_log("window:main-show-ok"),
            Err(error) => app_log(format!("window:main-show-error {error}")),
        }
        match window.unminimize() {
            Ok(_) => app_log("window:main-unminimize-ok"),
            Err(error) => app_log(format!("window:main-unminimize-error {error}")),
        }
        match window.set_focus() {
            Ok(_) => app_log("window:main-focus-ok"),
            Err(error) => app_log(format!("window:main-focus-error {error}")),
        }
        app_log(format!(
            "window:main-state visible={:?} minimized={:?}",
            window.is_visible(),
            window.is_minimized()
        ));
        return;
    }

    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
    else {
        app_log("window:main-config-missing");
        return;
    };

    match tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build())
    {
        Ok(window) => {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: 1180.0,
                height: 760.0,
            }));
            let _ = window.center();
            match window.show() {
                Ok(_) => app_log("window:main-create-show-ok"),
                Err(error) => app_log(format!("window:main-create-show-error {error}")),
            }
            match window.set_focus() {
                Ok(_) => app_log("window:main-create-focus-ok"),
                Err(error) => app_log(format!("window:main-create-focus-error {error}")),
            }
            app_log(format!(
                "window:main-created visible={:?} minimized={:?}",
                window.is_visible(),
                window.is_minimized()
            ));
        }
        Err(error) => {
            app_log(format!("window:create-error {error}"));
        }
    }
}

fn register_bundled_backend_resource(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(resource_dir) = app.path().resource_dir() else {
        return;
    };
    let backend_archive = resource_dir.join("spark-code-backend.tar.gz");
    if backend_archive.is_file() {
        env::set_var(BUNDLED_BACKEND_ROOT_ENV_KEY, backend_archive);
        return;
    }
    let backend_root = resource_dir.join("spark-code-backend");
    if path_has_spark_source(&backend_root) {
        env::set_var(BUNDLED_BACKEND_ROOT_ENV_KEY, backend_root);
    }
}

fn git_metadata_path(path: &Path) -> Option<PathBuf> {
    path.ancestors().take(8).find_map(|candidate| {
        let git_path = candidate.join(".git");
        if git_path.is_dir() {
            return Some(git_path);
        }
        if git_path.is_file() {
            let content = fs::read_to_string(&git_path).ok()?;
            let git_dir = content.trim().strip_prefix("gitdir:")?.trim();
            let resolved = PathBuf::from(git_dir);
            return Some(if resolved.is_absolute() {
                resolved
            } else {
                candidate.join(resolved)
            });
        }
        None
    })
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn source_repo_root() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source_root = manifest_dir.parent()?.parent()?.to_path_buf();
    if git_metadata_path(&source_root).is_some() {
        return Some(source_root);
    }
    None
}

fn short_revision(value: &str) -> String {
    value.chars().take(8).collect()
}

fn git_output(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = ProcessCommand::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .output()
        .map_err(|error| format!("无法执行 git：{error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git 命令失败：{}", output.status)
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_remote_url(repo: &Path) -> Option<String> {
    git_output(repo, &["remote", "get-url", "origin"]).ok()
}

fn git_current_revision(repo: &Path) -> Result<String, String> {
    git_output(repo, &["rev-parse", "HEAD"])
}

fn git_latest_revision(repo: &Path, branch: &str) -> Result<String, String> {
    let target = if branch == "HEAD" || branch == "detached" {
        "HEAD".to_string()
    } else {
        format!("refs/heads/{branch}")
    };
    let output = git_output(
        repo,
        &[
            "-c",
            "credential.helper=",
            "-c",
            "core.askPass=",
            "-c",
            "http.lowSpeedLimit=1",
            "-c",
            "http.lowSpeedTime=3",
            "ls-remote",
            "origin",
            &target,
        ],
    )?;
    output
        .lines()
        .find_map(|line| line.split_whitespace().next())
        .map(ToString::to_string)
        .filter(|revision| !revision.is_empty())
        .ok_or_else(|| "远端没有返回版本信息".to_string())
}

fn check_update_status() -> UpdateStatus {
    let checked_at = current_unix_ms();
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let Some(repo) = source_repo_root() else {
        return UpdateStatus {
            current_version,
            current_revision: None,
            latest_revision: None,
            checked_at,
            update_available: false,
            source: "bundle".to_string(),
            detail: "未找到本机源码 Git 仓库，只能读取当前应用版本。".to_string(),
            release_url: None,
            error: None,
        };
    };

    let current_revision = match git_current_revision(&repo) {
        Ok(value) => value,
        Err(error) => {
            return UpdateStatus {
                current_version,
                current_revision: None,
                latest_revision: None,
                checked_at,
                update_available: false,
                source: repo.display().to_string(),
                detail: "读取当前版本失败。".to_string(),
                release_url: git_remote_url(&repo),
                error: Some(error),
            };
        }
    };
    let latest_revision = match git_latest_revision(&repo, UPDATE_CHECK_BRANCH) {
        Ok(value) => value,
        Err(error) => {
            return UpdateStatus {
                current_version,
                current_revision: Some(current_revision.clone()),
                latest_revision: None,
                checked_at,
                update_available: false,
                source: repo.display().to_string(),
                detail: format!(
                    "已读取当前版本 {}，暂时无法读取远端更新。",
                    short_revision(&current_revision)
                ),
                release_url: git_remote_url(&repo),
                error: Some(error),
            };
        }
    };
    let update_available = current_revision != latest_revision;
    let detail = if update_available {
        format!(
            "当前 {}，远端 {}，main 分支有更新。",
            short_revision(&current_revision),
            short_revision(&latest_revision),
        )
    } else {
        format!(
            "当前 {}，main 分支已是最新。",
            short_revision(&current_revision),
        )
    };

    UpdateStatus {
        current_version,
        current_revision: Some(current_revision),
        latest_revision: Some(latest_revision),
        checked_at,
        update_available,
        source: repo.display().to_string(),
        detail,
        release_url: git_remote_url(&repo),
        error: None,
    }
}

fn read_git_branch(path: &Path) -> Option<String> {
    if is_internal_backend_path(path) {
        return None;
    }

    let git_path = git_metadata_path(path)?;
    let head = fs::read_to_string(git_path.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: refs/heads/") {
        return Some(reference.to_string());
    }
    if head.len() >= 7 && head.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Some(format!("detached@{}", &head[..7]));
    }
    None
}

fn workspace_info() -> WorkspaceInfo {
    let root = app_workspace();
    let folder = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("当前项目")
        .to_string();

    WorkspaceInfo {
        folder,
        path: root.display().to_string(),
        mode: "编写模式".to_string(),
        git_branch: read_git_branch(&root),
    }
}

fn load_projects(app: &tauri::AppHandle) -> Vec<ProjectEntry> {
    let mut projects = load_codex_projects();
    let overrides = load_project_overrides(app);
    for project in overrides.added.iter().cloned() {
        if !projects.iter().any(|item| item.path == project.path) {
            projects.push(project);
        }
    }
    let current = project_entry(
        app_workspace().display().to_string(),
        Some("current".to_string()),
    );
    if !projects.iter().any(|project| project.path == current.path) {
        projects.insert(0, current);
    }
    projects.retain(|project| {
        project.trust_level.as_deref() == Some("current")
            || !overrides.removed.iter().any(|path| path == &project.path)
    });
    projects
}

#[tauri::command]
fn get_app_snapshot(app: tauri::AppHandle) -> AppSnapshot {
    start_spark_backend();
    let _ = wait_for_local_backend_url();
    let spark_config = read_spark_config();
    let remote = load_remote_config(&app);
    if let Ok(mut config) = remote_config().lock() {
        *config = remote.clone();
    }
    let model = load_model_config(&app);
    if let Ok(mut config) = model_config().lock() {
        *config = model.clone();
    }
    let preferences = load_preferences(&spark_config);
    let workspace = workspace_info();
    let projects = load_projects(&app);
    let sessions = ensure_default_sessions(remote.configured);

    AppSnapshot {
        version: env!("CARGO_PKG_VERSION").to_string(),
        remote: remote.clone(),
        spark_user: refresh_spark_user_profile(&spark_config),
        remote_device: load_remote_device_binding(&app, &spark_config),
        preferences: preferences.clone(),
        model,
        workspace,
        skills: load_user_skills(),
        mcp_servers: load_user_mcp_servers(),
        tools: load_tool_catalog(&preferences.permission_mode),
        projects,
        recent_changes: load_recent_changes(&app),
        slash_commands: Vec::new(),
        backend_runtime: backend_runtime_snapshot(),
        update_status: check_update_status(),
        sessions,
    }
}

#[tauri::command]
fn check_app_update() -> UpdateStatus {
    check_update_status()
}

fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[tauri::command]
fn pick_project_folder(base_path: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let base = if base_path.trim().is_empty() {
            app_workspace()
        } else {
            PathBuf::from(base_path.trim())
        };
        let base = if base.is_dir() {
            base
        } else {
            base.parent()
                .map(PathBuf::from)
                .unwrap_or_else(app_workspace)
        };
        let default_location = fs::canonicalize(&base)
            .ok()
            .filter(|path| path.is_dir())
            .map(|path| {
                format!(
                    " default location POSIX file \"{}\"",
                    escape_applescript_string(&path.display().to_string())
                )
            })
            .unwrap_or_default();
        let script = format!(
            "POSIX path of (choose folder with prompt \"选择项目文件夹\"{default_location})"
        );
        let output = ProcessCommand::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|error| format!("无法打开文件夹选择器：{error}"))?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok((!path.is_empty()).then_some(path));
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("-128") || stderr.to_lowercase().contains("user canceled") {
            return Ok(None);
        }
        return Err(format!("文件夹选择失败：{}", stderr.trim()));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = base_path;
        Ok(None)
    }
}

#[tauri::command]
fn get_project_metadata(project_path: String) -> Result<ProjectEntry, String> {
    let trimmed = project_path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let canonical = canonical_project_path(trimmed);
    Ok(project_entry(canonical, None))
}

#[tauri::command]
fn save_remote_config(app: tauri::AppHandle, _backend_url: String) -> Result<RemoteConfig, String> {
    let next = default_remote_config();

    let mut config = remote_config()
        .lock()
        .map_err(|_| "Remote 配置暂时不可用".to_string())?;
    persist_remote_config(&app, &next)?;
    *config = next.clone();
    Ok(next)
}

#[tauri::command]
fn save_preferences(preferences: AppPreferences) -> Result<AppPreferences, String> {
    let mut config = read_spark_config();
    if !config.is_object() {
        config = Value::Object(Map::new());
    }

    let root = config
        .as_object_mut()
        .ok_or_else(|| "Spark 配置格式无效".to_string())?;

    let permission_mode = normalize_permission_mode(&preferences.permission_mode);
    let backend_mode = backend_permission_mode(&permission_mode);
    root.insert(
        "permissionMode".to_string(),
        Value::String(permission_mode.clone()),
    );
    root.insert(
        "backendPermissionMode".to_string(),
        Value::String(backend_mode.to_string()),
    );
    let permissions_value = root
        .entry("permissions".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !permissions_value.is_object() {
        *permissions_value = Value::Object(Map::new());
    }
    if let Some(permissions) = permissions_value.as_object_mut() {
        permissions.insert(
            "defaultMode".to_string(),
            Value::String(backend_mode.to_string()),
        );
    }

    match preferences.remote_control_at_startup {
        Some(value) => {
            root.insert("remoteControlAtStartup".to_string(), Value::Bool(value));
        }
        None => {
            root.remove("remoteControlAtStartup");
        }
    }
    set_bool(root, "autoCompactEnabled", preferences.auto_compact_enabled);
    set_bool(root, "showTurnDuration", preferences.show_turn_duration);
    set_bool(
        root,
        "terminalProgressBarEnabled",
        preferences.terminal_progress_bar_enabled,
    );
    set_bool(
        root,
        "fileCheckpointingEnabled",
        preferences.file_checkpointing_enabled,
    );
    set_bool(root, "respectGitignore", preferences.respect_gitignore);
    set_bool(root, "copyFullResponse", preferences.copy_full_response);
    set_bool(root, "autoConnectIde", preferences.auto_connect_ide);
    set_bool(
        root,
        "autoInstallIdeExtension",
        preferences.auto_install_ide_extension,
    );

    write_spark_config(&config)?;
    Ok(AppPreferences {
        permission_mode,
        ..preferences
    })
}

#[tauri::command]
fn bind_remote_device(
    app: tauri::AppHandle,
    binding_code: String,
) -> Result<RemoteDeviceBinding, String> {
    let code = binding_code.trim();
    if code.is_empty() {
        return Err("请输入 Remote 绑定码".to_string());
    }

    let mut config = read_spark_config();
    let (install_id, device_id) = get_or_create_android_device(&mut config)?;
    write_spark_config(&config)?;

    let client_name = "Spark Code Desktop".to_string();
    let body = serde_json::json!({
        "code": code,
        "client_id": install_id,
        "client_name": client_name,
        "client_version": env!("CARGO_PKG_VERSION"),
        "data": {
            "platform": env::consts::OS,
            "editor": "sparkcode-app",
        },
        "meta": {
            "device_id": device_id,
            "app": "Spark Code",
        },
    })
    .to_string();
    let url = format!("{FIXED_BACKEND_URL}{SPARK_CODE_API_PATH}/client/bind");
    let value = curl_json(&[
        "-sS".to_string(),
        "--max-time".to_string(),
        "20".to_string(),
        "-w".to_string(),
        "\n%{http_code}".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
        "-d".to_string(),
        body,
        url,
    ])?;

    let client_token = value_string(value.get("client_token"))
        .ok_or_else(|| "后端没有返回 Remote client_token".to_string())?;
    let endpoint = resolve_remote_response_endpoint(value_string(value.get("endpoint")));
    let stream_endpoint = resolve_remote_response_stream_endpoint(
        value_string(value.get("stream_endpoint")),
        &endpoint,
    );
    let remote_client = RemoteClientConfig {
        binding_id: value_string(value.get("id")),
        client_token: Some(client_token),
        endpoint,
        stream_endpoint,
        client_name: value_string(value.get("client_name")).or(Some(client_name)),
        status: value_string(value.get("status")),
    };
    persist_remote_client_config(&app, &remote_client)?;

    let config = read_spark_config();
    Ok(load_remote_device_binding(&app, &config))
}

#[tauri::command]
fn unbind_remote_device(app: tauri::AppHandle) -> Result<RemoteDeviceBinding, String> {
    remove_remote_client_config(&app)?;
    let config = read_spark_config();
    Ok(load_remote_device_binding(&app, &config))
}

#[tauri::command]
fn logout_spark() -> Result<SparkUserProfile, String> {
    start_spark_backend();
    let _ = post_local_backend_json("/auth/clear", &serde_json::json!({}));

    let config = clear_spark_login_state()?;
    Ok(load_spark_user_profile(&config))
}

#[tauri::command]
fn save_backend_base_url(raw_value: String) -> Result<String, String> {
    let normalized = normalize_backend_base_url(&raw_value)?;
    let previous = env_string(&read_spark_config(), SPARK_BASE_URL_ENV_KEY);
    let mut config = read_spark_config();
    {
        let env_root = env_object_mut(&mut config)?;
        env_root.insert(
            SPARK_BASE_URL_ENV_KEY.to_string(),
            Value::String(normalized.clone()),
        );
        if previous.as_deref() != Some(normalized.as_str()) {
            env_root.remove(SPARK_AUTH_TOKEN_ENV_KEY);
            env_root.remove(SPARK_REFRESH_TOKEN_ENV_KEY);
        }
    }
    if previous.as_deref() != Some(normalized.as_str()) {
        if let Some(root) = config.as_object_mut() {
            root.remove("oauthAccount");
        }
    }
    write_spark_config(&config)?;
    stop_spark_backend();
    start_spark_backend_async();
    Ok(normalized)
}

fn save_spark_login(
    token_response: Value,
    profile: Option<Value>,
) -> Result<SparkUserProfile, String> {
    let access_token = value_string(token_response.get("access_token"))
        .or_else(|| value_string(token_response.get("accessToken")))
        .ok_or_else(|| "后端没有返回访问令牌".to_string())?;
    let refresh_token = value_string(token_response.get("refresh_token"))
        .or_else(|| value_string(token_response.get("refreshToken")));
    let mut config = read_spark_config();
    {
        let env_root = env_object_mut(&mut config)?;
        env_root.insert(
            SPARK_BASE_URL_ENV_KEY.to_string(),
            Value::String(FIXED_BACKEND_URL.to_string()),
        );
        env_root.insert(
            SPARK_AUTH_TOKEN_ENV_KEY.to_string(),
            Value::String(access_token),
        );
        if let Some(refresh_token) = refresh_token {
            env_root.insert(
                SPARK_REFRESH_TOKEN_ENV_KEY.to_string(),
                Value::String(refresh_token),
            );
        } else {
            env_root.remove(SPARK_REFRESH_TOKEN_ENV_KEY);
        }
    }

    let mut oauth_account: Option<Map<String, Value>> = None;
    if let Some(profile) = profile {
        let account_uuid = nested_string(&profile, &[
            &["sub"],
            &["uuid"],
            &["id"],
            &["account_uuid"],
            &["accountUuid"],
            &["account", "uuid"],
            &["account", "id"],
        ]);
        let email = nested_string(&profile, &[
            &["email"],
            &["email_address"],
            &["emailAddress"],
            &["account", "email"],
            &["account", "email_address"],
            &["account", "emailAddress"],
        ]);

        if let (Some(account_uuid), Some(email)) = (account_uuid, email) {
            let mut item = Map::new();
            item.insert("accountUuid".to_string(), Value::String(account_uuid));
            item.insert("emailAddress".to_string(), Value::String(email));
            if let Some(value) = nested_string(&profile, &[
                &["name"],
                &["display_name"],
                &["displayName"],
                &["preferred_username"],
                &["account", "display_name"],
                &["account", "displayName"],
                &["account", "name"],
            ])
            {
                item.insert("displayName".to_string(), Value::String(value));
            }
            if let Some(value) = nested_string(&profile, &[
                &["picture"],
                &["avatar_url"],
                &["avatarUrl"],
                &["account", "picture"],
                &["account", "avatar_url"],
                &["account", "avatarUrl"],
            ]) {
                let avatar_url = if value.starts_with('/') {
                    format!("{FIXED_BACKEND_URL}{value}")
                } else {
                    value
                };
                item.insert("avatarUrl".to_string(), Value::String(avatar_url));
            }
            if let Some(value) = nested_string(&profile, &[
                &["organization_uuid"],
                &["organizationUuid"],
                &["organization", "uuid"],
                &["organization", "id"],
            ]) {
                item.insert("organizationUuid".to_string(), Value::String(value));
            }
            if let Some(value) = nested_string(&profile, &[
                &["organization_name"],
                &["organizationName"],
                &["organization", "name"],
                &["organization", "display_name"],
            ]) {
                item.insert("organizationName".to_string(), Value::String(value));
            }
            if let Some(value) = nested_string(&profile, &[
                &["billing_type"],
                &["billingType"],
                &["organization", "billing_type"],
                &["organization", "billingType"],
            ]) {
                item.insert("billingType".to_string(), Value::String(value));
            }
            if let Some(value) = nested_string(&profile, &[
                &["created_at"],
                &["createdAt"],
                &["account", "created_at"],
                &["account", "createdAt"],
            ]) {
                item.insert("accountCreatedAt".to_string(), Value::String(value));
            }
            oauth_account = Some(item);
        }
    }

    {
        let root = root_object_mut(&mut config)?;
        root.insert("hasCompletedOnboarding".to_string(), Value::Bool(true));
        let account = oauth_account.unwrap_or_else(|| {
            let mut item = Map::new();
            item.insert("accountUuid".to_string(), Value::String("spark-oauth".to_string()));
            item.insert("displayName".to_string(), Value::String("Spark 用户".to_string()));
            item
        });
        root.insert("oauthAccount".to_string(), Value::Object(account));
    }

    write_spark_config(&config)?;
    Ok(load_spark_user_profile(&config))
}

#[tauri::command]
fn start_spark_login() -> Result<String, String> {
    let mut config = read_spark_config();
    let (install_id, device_id) = get_or_create_android_device(&mut config)?;
    write_spark_config(&config)?;

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("无法启动 OAuth 本地回调：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法读取 OAuth 回调端口：{error}"))?
        .port();
    let callback_url = build_oauth_callback_url(port);
    let state = compact_id("spark-oauth-");
    let auth_url = build_spark_oauth_url(
        FIXED_BACKEND_URL,
        &callback_url,
        &state,
        &install_id,
        &device_id,
    );

    open_browser(&auth_url)?;
    let refresh_token = wait_for_oauth_code(listener, &state)?;
    let token_response = exchange_android_refresh_token(&refresh_token, &install_id, &device_id)?;
    let access_token = value_string(token_response.get("access_token"))
        .or_else(|| value_string(token_response.get("accessToken")))
        .ok_or_else(|| "后端没有返回访问令牌".to_string())?;
    let profile = fetch_spark_profile(&access_token);
    let user = save_spark_login(token_response, profile)?;

    Ok(user
        .name
        .or(user.email)
        .unwrap_or_else(|| "login-success".to_string()))
}

#[tauri::command]
fn refresh_spark_auth() -> Result<SparkUserProfile, String> {
    let mut config = read_spark_config();
    let refresh_token = env_string(&config, SPARK_REFRESH_TOKEN_ENV_KEY)
        .ok_or_else(|| "没有可刷新的登录凭据，请重新登录".to_string())?;
    let (install_id, device_id) = get_or_create_android_device(&mut config)?;
    write_spark_config(&config)?;
    let token_response = exchange_android_refresh_token(&refresh_token, &install_id, &device_id)?;
    let access_token = value_string(token_response.get("access_token"))
        .or_else(|| value_string(token_response.get("accessToken")))
        .ok_or_else(|| "后端没有返回新的访问令牌".to_string())?;
    let profile = fetch_spark_profile(&access_token);
    save_spark_login(token_response, profile)
}

#[tauri::command]
fn revert_change(app: tauri::AppHandle, change_id: String) -> Result<Vec<RecentChange>, String> {
    let mut changes = load_recent_changes(&app);
    let change = changes
        .iter_mut()
        .find(|item| item.id == change_id)
        .ok_or_else(|| "没有找到这条更改记录".to_string())?;

    if !change.can_revert || change.status == "reverted" {
        return Err("这条更改不能 Revert".to_string());
    }

    let before_content = change
        .before_content
        .as_ref()
        .ok_or_else(|| "这条更改缺少可恢复内容".to_string())?;

    fs::write(&change.path, before_content).map_err(|error| format!("Revert 失败：{error}"))?;
    change.status = "reverted".to_string();
    change.can_revert = false;
    persist_recent_changes(&app, &changes)?;
    Ok(changes)
}

#[tauri::command]
fn get_model_config(app: tauri::AppHandle) -> Result<ModelConfig, String> {
    let mut current = load_model_config(&app);
    let backend_options = backend_model_options();
    if !backend_options.is_empty() {
        current.options = backend_options;
        current = ensure_selected_model_option(current);
        let _ = persist_model_config(&app, &current);
    }
    if let Ok(mut config) = model_config().lock() {
        *config = current.clone();
    }
    Ok(current)
}

#[tauri::command]
fn save_model_config(app: tauri::AppHandle, model: String) -> Result<ModelConfig, String> {
    let selected = model.trim();
    if selected.is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    let mut options = model_config()
        .lock()
        .ok()
        .map(|config| config.options.clone())
        .unwrap_or_default();
    if options.is_empty() {
        options = load_model_config(&app).options;
    }
    if options.is_empty() {
        options = backend_model_options();
    }
    if !options.is_empty() && !options.iter().any(|option| option.id == selected) {
        return Err("只能选择 Spark 后端返回的模型".to_string());
    }
    let mut next = if options.is_empty() {
        ModelConfig {
            selected: selected.to_string(),
            options: Vec::new(),
        }
    } else {
        model_config_with_options(options)
    };
    next.selected = selected.to_string();
    if !next.options.is_empty() {
        next = ensure_selected_model_option(next);
    }

    let mut config = model_config()
        .lock()
        .map_err(|_| "模型配置暂时不可用".to_string())?;
    persist_model_config(&app, &next)?;
    *config = next.clone();
    Ok(next)
}

#[tauri::command]
fn rename_session(session_id: String, title: String) -> Result<Vec<Session>, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("会话标题不能为空".to_string());
    }

    let mut sessions = app_sessions()
        .lock()
        .map_err(|_| "会话状态暂时不可用".to_string())?;
    let session = sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    session.title = trimmed.to_string();
    Ok(sessions.clone())
}

#[tauri::command]
fn archive_session(session_id: String) -> Result<Vec<Session>, String> {
    let mut sessions = app_sessions()
        .lock()
        .map_err(|_| "会话状态暂时不可用".to_string())?;
    let before = sessions.len();
    sessions.retain(|session| session.id != session_id);
    if sessions.len() == before {
        return Err("会话不存在".to_string());
    }
    Ok(sessions.clone())
}

#[tauri::command]
fn remove_project_path(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<Vec<ProjectEntry>, String> {
    let trimmed = project_path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let canonical = canonical_project_path(trimmed);
    let current = canonical_project_path(app_workspace());
    if canonical == current {
        return Err("当前路径不能移除".to_string());
    }

    let mut overrides = load_project_overrides(&app);
    overrides.added.retain(|project| project.path != canonical);
    if !overrides.removed.iter().any(|path| path == &canonical) {
        overrides.removed.push(canonical.clone());
    }
    persist_project_overrides(&app, &overrides)?;

    if let Ok(mut sessions) = app_sessions().lock() {
        sessions.retain(|session| session.project_path != canonical);
    }

    Ok(load_projects(&app))
}

#[tauri::command]
fn add_project_path(
    app: tauri::AppHandle,
    path: String,
    base_path: String,
) -> Result<ProjectEntry, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请输入路径".to_string());
    }

    let input = PathBuf::from(trimmed);
    let path = if input.is_absolute() {
        input
    } else {
        let base = if base_path.trim().is_empty() {
            app_workspace()
        } else {
            PathBuf::from(base_path.trim())
        };
        base.join(input)
    };
    let canonical = fs::canonicalize(&path).map_err(|error| format!("无法打开路径：{error}"))?;
    if !canonical.is_dir() {
        return Err("路径必须是文件夹".to_string());
    }

    let project = project_entry(canonical.display().to_string(), Some("added".to_string()));
    let mut overrides = load_project_overrides(&app);
    overrides.removed.retain(|path| path != &project.path);
    if !overrides.added.iter().any(|item| item.path == project.path) {
        overrides.added.push(project.clone());
    }
    persist_project_overrides(&app, &overrides)?;
    Ok(project)
}

#[tauri::command]
fn open_memory_file() -> Result<String, String> {
    let path = ensure_memory_file()?;

    #[cfg(target_os = "macos")]
    {
        ProcessCommand::new("open")
            .arg(&path)
            .spawn()
            .map_err(|error| format!("无法打开记忆文件：{error}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let editor = env::var_os("VISUAL")
            .or_else(|| env::var_os("EDITOR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("vi"));
        ProcessCommand::new(editor)
            .arg(&path)
            .spawn()
            .map_err(|error| format!("无法打开记忆文件：{error}"))?;
    }

    Ok(path.display().to_string())
}

fn memory_file_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(home.join(".sparkc").join("CLAUDE.md"))
}

fn ensure_memory_file() -> Result<PathBuf, String> {
    let path = memory_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建记忆目录：{error}"))?;
    }
    if !path.exists() {
        fs::write(&path, "").map_err(|error| format!("无法创建记忆文件：{error}"))?;
    }
    Ok(path)
}

#[tauri::command]
fn read_memory_file() -> Result<MemoryDocument, String> {
    let path = memory_file_path()?;
    let exists = path.exists();
    let content = if exists {
        fs::read_to_string(&path).map_err(|error| format!("无法读取记忆文件：{error}"))?
    } else {
        String::new()
    };
    Ok(MemoryDocument {
        path: path.display().to_string(),
        content,
        exists,
    })
}

#[tauri::command]
fn save_memory_file(content: String) -> Result<MemoryDocument, String> {
    let path = ensure_memory_file()?;
    fs::write(&path, content).map_err(|error| format!("无法保存记忆文件：{error}"))?;
    read_memory_file()
}

#[tauri::command]
fn delete_memory_file() -> Result<MemoryDocument, String> {
    let path = memory_file_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("无法删除记忆文件：{error}"))?;
    }
    Ok(MemoryDocument {
        path: path.display().to_string(),
        content: String::new(),
        exists: false,
    })
}

#[tauri::command]
fn export_session_text(
    file_name: String,
    project_path: String,
    content: String,
) -> Result<String, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("请输入导出文件名".to_string());
    }

    let mut target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        let base = if project_path.trim().is_empty() {
            app_workspace()
        } else {
            PathBuf::from(project_path.trim())
        };
        target = base.join(target);
    }
    if target.extension().and_then(|extension| extension.to_str()) != Some("txt") {
        target.set_extension("txt");
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建导出目录：{error}"))?;
    }
    fs::write(&target, content).map_err(|error| format!("导出对话失败：{error}"))?;
    Ok(target.display().to_string())
}

#[tauri::command]
fn start_session(title: String, project_path: String) -> Session {
    let trimmed = title.trim();
    let remote = remote_config()
        .lock()
        .map(|config| config.configured)
        .unwrap_or(false);
    let project_path = if project_path.trim().is_empty() {
        canonical_project_path(app_workspace())
    } else {
        canonical_project_path(project_path.trim())
    };
    let title = if trimmed.is_empty() {
        "新对话".to_string()
    } else {
        trimmed.to_string()
    };

    if let Ok(mut sessions) = app_sessions().lock() {
        prune_empty_current_sessions(&mut sessions);
        if title == "当前会话" {
            if let Some(session) = sessions
                .iter()
                .find(|session| {
                    is_empty_current_session(session)
                        && normalized_session_project_key(&session.project_path)
                            == normalized_session_project_key(&project_path)
                })
                .cloned()
            {
                return session;
            }
        }

        let session = create_app_session(title, project_path, remote);
        sessions.insert(0, session.clone());
        prune_empty_current_sessions(&mut sessions);
        return session;
    }

    create_app_session(title, project_path, remote)
}

#[tauri::command]
fn list_project_files(project_path: String, query: String) -> Vec<ProjectFileEntry> {
    let root = if project_path.trim().is_empty() {
        app_workspace()
    } else {
        PathBuf::from(project_path.trim())
    };
    let root = fs::canonicalize(&root).unwrap_or(root);
    if !root.is_dir() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut visited = 0;
    collect_project_files(&root, &root, query.trim(), &mut visited, &mut out);
    out.sort_by(|a, b| {
        a.path
            .len()
            .cmp(&b.path.len())
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    out
}

#[tauri::command]
fn list_project_directory(
    project_path: String,
    directory_path: String,
) -> Result<Vec<ProjectDirectoryEntry>, String> {
    let (root, directory, _) = resolve_project_child_path(&project_path, &directory_path, false)?;
    if !directory.is_dir() {
        return Err("路径必须是文件夹".to_string());
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&directory).map_err(|error| format!("无法读取目录：{error}"))?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if should_skip_project_file_entry(&path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(ProjectDirectoryEntry {
            path: display_relative_path(&root, &path),
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified_at: metadata_modified_millis(&metadata),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
fn create_project_directory(
    project_path: String,
    directory_path: String,
) -> Result<Vec<ProjectDirectoryEntry>, String> {
    let (_, directory, _) = resolve_project_child_path(&project_path, &directory_path, true)?;
    if directory.exists() {
        if directory.is_dir() {
            return list_project_directory(project_path, directory_path);
        }
        return Err("同名文件已存在".to_string());
    }
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建文件夹：{error}"))?;
    let parent = directory
        .parent()
        .and_then(|path| {
            let root = project_root_from_input(&project_path).ok()?;
            Some(display_relative_path(&root, path))
        })
        .unwrap_or_default();
    list_project_directory(project_path, parent)
}

#[tauri::command]
fn rename_project_entry(
    project_path: String,
    from_path: String,
    to_path: String,
) -> Result<Vec<ProjectDirectoryEntry>, String> {
    let (_, source, _) = resolve_project_child_path(&project_path, &from_path, false)?;
    let (_, target, target_relative) = resolve_project_child_path(&project_path, &to_path, true)?;
    if !source.exists() {
        return Err("原路径不存在".to_string());
    }
    if target.exists() {
        return Err("目标路径已存在".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目标目录：{error}"))?;
    }
    fs::rename(&source, &target).map_err(|error| format!("无法重命名：{error}"))?;
    list_project_directory(project_path, parent_directory_rust(&target_relative))
}

fn parent_directory_rust(path: &str) -> String {
    let normalized = path.trim_matches('/').replace('\\', "/");
    normalized
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn delete_project_directory(
    project_path: String,
    directory_path: String,
) -> Result<Vec<ProjectDirectoryEntry>, String> {
    let (_, directory, relative) =
        resolve_project_child_path(&project_path, &directory_path, false)?;
    if !directory.is_dir() {
        return Err("只能删除文件夹".to_string());
    }
    if relative.trim().is_empty() {
        return Err("不能删除项目根目录".to_string());
    }
    fs::remove_dir(&directory).map_err(|error| {
        if error.kind() == std::io::ErrorKind::DirectoryNotEmpty {
            "文件夹非空，暂不支持递归删除".to_string()
        } else {
            format!("无法删除文件夹：{error}")
        }
    })?;
    list_project_directory(project_path, parent_directory_rust(&relative))
}

#[tauri::command]
fn read_project_file(
    project_path: String,
    file_path: String,
) -> Result<ProjectFileDocument, String> {
    let (root, path, relative) = resolve_project_child_path(&project_path, &file_path, false)?;
    if !path.is_file() {
        return Err("路径必须是文件".to_string());
    }
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if metadata.len() > 2_000_000 {
        return Err("文件过大，暂不在界面内直接打开".to_string());
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("无法读取文本文件：{error}"))?;
    Ok(ProjectFileDocument {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&relative)
            .to_string(),
        path: display_relative_path(&root, &path),
        content,
        exists: true,
        size: metadata.len(),
        modified_at: metadata_modified_millis(&metadata),
        recent_changes: Vec::new(),
    })
}

fn current_timestamp_millis_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[tauri::command]
fn save_project_file(
    app: tauri::AppHandle,
    project_path: String,
    file_path: String,
    content: String,
) -> Result<ProjectFileDocument, String> {
    let (root, path, relative) = resolve_project_child_path(&project_path, &file_path, true)?;
    if path.is_dir() {
        return Err("不能把文件内容保存到文件夹".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建文件目录：{error}"))?;
    }
    let existed = path.exists();
    let before_content = if existed {
        fs::read_to_string(&path).map_err(|error| format!("无法读取原文件：{error}"))?
    } else {
        String::new()
    };
    fs::write(&path, &content).map_err(|error| format!("无法保存文件：{error}"))?;

    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取文件信息：{error}"))?;
    let (added_lines, removed_lines) = line_change_counts(&before_content, &content);
    let mut recent_changes = load_recent_changes(&app);
    recent_changes.insert(
        0,
        RecentChange {
            id: compact_id("change-"),
            title: if existed {
                format!("编辑 {}", relative)
            } else {
                format!("新建 {}", relative)
            },
            path: path.display().to_string(),
            summary: format!("通过 Spark Code 文件面板保存，+{added_lines} -{removed_lines}"),
            timestamp: current_timestamp_millis_string(),
            status: "active".to_string(),
            can_revert: existed,
            before_content: existed.then_some(before_content),
            added_lines,
            removed_lines,
        },
    );
    recent_changes.truncate(100);
    persist_recent_changes(&app, &recent_changes)?;

    Ok(ProjectFileDocument {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&relative)
            .to_string(),
        path: display_relative_path(&root, &path),
        content,
        exists: true,
        size: metadata.len(),
        modified_at: metadata_modified_millis(&metadata),
        recent_changes,
    })
}

#[tauri::command]
fn delete_project_file(
    app: tauri::AppHandle,
    project_path: String,
    file_path: String,
) -> Result<Vec<RecentChange>, String> {
    let (_, path, relative) = resolve_project_child_path(&project_path, &file_path, false)?;
    if !path.is_file() {
        return Err("只能删除文件".to_string());
    }
    let before_content =
        fs::read_to_string(&path).map_err(|error| format!("无法读取原文件：{error}"))?;
    let removed_lines = before_content.lines().count().min(u32::MAX as usize) as u32;
    fs::remove_file(&path).map_err(|error| format!("无法删除文件：{error}"))?;

    let mut recent_changes = load_recent_changes(&app);
    recent_changes.insert(
        0,
        RecentChange {
            id: compact_id("change-"),
            title: format!("删除 {}", relative),
            path: path.display().to_string(),
            summary: format!("通过 Spark Code 文件面板删除，+0 -{removed_lines}"),
            timestamp: current_timestamp_millis_string(),
            status: "active".to_string(),
            can_revert: true,
            before_content: Some(before_content),
            added_lines: 0,
            removed_lines,
        },
    );
    recent_changes.truncate(100);
    persist_recent_changes(&app, &recent_changes)?;
    Ok(recent_changes)
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn plist_string_values(value: &str) -> Vec<String> {
    let mut rest = value;
    let mut out = Vec::new();

    while let Some(start) = rest.find("<string>") {
        let after_start = &rest[start + "<string>".len()..];
        let Some(end) = after_start.find("</string>") else {
            break;
        };
        let item = xml_unescape(after_start[..end].trim());
        if !item.is_empty() {
            out.push(item);
        }
        rest = &after_start[end + "</string>".len()..];
    }

    out
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

fn file_url_to_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(path) = trimmed.strip_prefix("file://localhost") {
        return Some(percent_decode(path));
    }
    if let Some(path) = trimmed.strip_prefix("file://") {
        return Some(percent_decode(path));
    }
    if trimmed.starts_with('/') {
        return Some(trimmed.to_string());
    }
    None
}

fn push_unique_path(paths: &mut Vec<String>, path: String) {
    if !path.trim().is_empty() && !paths.iter().any(|item| item == &path) {
        paths.push(path);
    }
}

#[cfg(target_os = "macos")]
fn macos_pasteboard_string(pasteboard_type: &str) -> Option<String> {
    let escaped_type = pasteboard_type.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "ObjC.import('AppKit'); const value = $.NSPasteboard.generalPasteboard.stringForType(\"{}\"); value ? ObjC.unwrap(value) : '';",
        escaped_type
    );
    let output = ProcessCommand::new("osascript")
        .args(["-l", "JavaScript", "-e", &script])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "macos")]
fn macos_clipboard_file_paths() -> Vec<String> {
    let mut paths = Vec::new();
    let pasteboard_types = [
        "NSFilenamesPboardType",
        "public.file-url",
        "com.trolltech.anymime.text--uri-list",
        "Apple URL pasteboard type",
    ];

    for pasteboard_type in pasteboard_types {
        let Some(value) = macos_pasteboard_string(pasteboard_type) else {
            continue;
        };
        let candidates = if value.contains("<plist") {
            plist_string_values(&value)
        } else {
            value
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .map(ToString::to_string)
                .collect()
        };

        for candidate in candidates {
            if let Some(path) = file_url_to_path(&candidate) {
                push_unique_path(&mut paths, path);
            }
        }
    }

    paths
}

#[tauri::command]
fn read_clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        return macos_clipboard_file_paths();
    }

    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[tauri::command]
fn send_prompt(
    prompt: String,
    session_id: String,
    project_path: String,
    model: Option<String>,
    permission_mode: Option<String>,
    resume: Option<bool>,
    images: Option<Vec<ImageAttachment>>,
) -> Result<ChatMessage, String> {
    let trimmed = prompt.trim();
    let images_empty = images
        .as_ref()
        .map(|items| items.is_empty())
        .unwrap_or(true);
    if trimmed.is_empty() && images_empty {
        return Err("请输入要发送的内容".to_string());
    }
    let effective_prompt = if trimmed.is_empty() {
        "请分析这些图片"
    } else {
        trimmed
    };

    start_spark_backend();
    let project_path = if project_path.trim().is_empty() {
        canonical_project_path(app_workspace())
    } else {
        canonical_project_path(project_path.trim())
    };
    let mut body = serde_json::json!({
        "prompt": effective_prompt,
        "cwd": project_path,
    });
    if !session_id.trim().is_empty() {
        body["session_id"] = serde_json::json!(session_id.trim());
        body["session_key"] = serde_json::json!(format!(
            "sparkcode-app:{project_path}:{}",
            session_id.trim()
        ));
    }
    if let Some(model) = model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["model"] = serde_json::json!(model);
    }
    if let Some(permission_mode) = permission_mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["permission_mode"] = serde_json::json!(backend_permission_mode(permission_mode));
    }
    if let Some(resume) = resume {
        body["resume"] = serde_json::json!(resume);
    }
    if let Some(images) = images.filter(|items| !items.is_empty()) {
        body["images"] = serde_json::json!(images);
    }
    let value = post_local_backend_json("/prompt", &body)?;

    Ok(ChatMessage {
        id: value_string(value.get("id")).unwrap_or_else(|| compact_id("assistant-")),
        role: value_string(value.get("role")).unwrap_or_else(|| "assistant".to_string()),
        content: value_string(value.get("content")).unwrap_or_else(|| "已完成".to_string()),
    })
}

#[tauri::command]
fn close_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Regular);
                let _ = app.set_dock_visibility(true);
            }
            show_main_window(app.app_handle());
            register_bundled_backend_resource(app.app_handle());
            start_spark_backend_async();
            Ok(())
        })
        .on_window_event(|_, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                stop_spark_backend();
            }
        })
        .invoke_handler(tauri::generate_handler![
            ensure_local_backend,
            set_active_project_path,
            get_app_snapshot,
            save_remote_config,
            save_preferences,
            bind_remote_device,
            unbind_remote_device,
            logout_spark,
            save_backend_base_url,
            start_spark_login,
            refresh_spark_auth,
            revert_change,
            get_model_config,
            save_model_config,
            rename_session,
            archive_session,
            remove_project_path,
            add_project_path,
            pick_project_folder,
            open_memory_file,
            read_memory_file,
            save_memory_file,
            delete_memory_file,
            export_session_text,
            get_slash_commands,
            get_tool_catalog,
            run_local_command,
            submit_feedback,
            start_session,
            list_project_files,
            list_project_directory,
            create_project_directory,
            rename_project_entry,
            delete_project_directory,
            read_project_file,
            save_project_file,
            delete_project_file,
            read_clipboard_file_paths,
            send_prompt,
            close_app,
            get_project_metadata,
            check_app_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building Spark Code")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Ready | tauri::RunEvent::Reopen { .. }
            ) {
                show_main_window(app);
                start_spark_backend_async();
            }
        });
}
