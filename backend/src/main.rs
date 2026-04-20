use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use dashmap::DashMap;
use futures::{SinkExt, StreamExt};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

// ─── Config ──────────────────────────────────────────────────────────────────

const JWT_SECRET: &str = "supersecretjwtkey2024webrtccaller";
const GOOGLE_CLIENT_ID: &str =
    "587752196180-tlu3l06kmtl2655sd6fpa74gm4ka2c3h.apps.googleusercontent.com";

// ─── Types ───────────────────────────────────────────────────────────────────

type RoomMap = Arc<DashMap<String, RoomState>>;

struct RoomState {
    tx: broadcast::Sender<String>,
    users: DashMap<String, UserInfo>,
}

#[derive(Deserialize)]
struct WsQuery {
    room: String,
    token: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum WsMessage {
    UserJoined {
        user_id: String,
        name: String,
        picture: String,
        users: Vec<UserInfo>,
    },
    UserLeft {
        user_id: String,
    },
    Offer {
        from: String,
        to: String,
        sdp: String,
    },
    Answer {
        from: String,
        to: String,
        sdp: String,
    },
    IceCandidate {
        from: String,
        to: String,
        candidate: String,
    },
    Chat {
        from: String,
        name: String,
        message: String,
    },
    CamStatus {
        user_id: String,
        enabled: bool,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct UserInfo {
    user_id: String,
    name: String,
    email: String,
    picture: String,
}

// ─── JWT Claims ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Claims {
    sub: String, // email as user_id
    name: String,
    email: String,
    picture: String,
    exp: usize,
}

// ─── Google Token Verification ───────────────────────────────────────────────

#[derive(Deserialize)]
struct GoogleTokenInfo {
    email: Option<String>,
    name: Option<String>,
    picture: Option<String>,
    aud: Option<String>,
    email_verified: Option<String>,
}

#[derive(Deserialize)]
struct GoogleAuthRequest {
    credential: String,
}

#[derive(Serialize)]
struct AuthResponse {
    token: String,
    name: String,
    email: String,
    picture: String,
}

#[derive(Serialize)]
struct CreateRoomResponse {
    room_id: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Serialize)]
struct IceServerEntry {
    urls: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}

#[derive(Serialize)]
struct IceServersResponse {
    ice_servers: Vec<IceServerEntry>,
}

// ─── Main ────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    println!("Rust signaling server starting...");

    let rooms: RoomMap = Arc::new(DashMap::new());

    let app = Router::new()
        .route("/api/auth/google", post(google_auth))
        .route("/api/auth/verify", get(verify_token))
        .route("/api/create-room", get(create_room))
        .route("/api/ice-servers", get(ice_servers))
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(rooms);

    let addr = "0.0.0.0:8080";
    println!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// ─── Auth Handlers ───────────────────────────────────────────────────────────

async fn google_auth(
    Json(body): Json<GoogleAuthRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    // Verify Google token via Google's tokeninfo endpoint
    let url = format!(
        "https://oauth2.googleapis.com/tokeninfo?id_token={}",
        body.credential
    );

    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: "Failed to verify Google token".into(),
                }),
            )
        })?;

    if !res.status().is_success() {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Invalid Google token".into(),
            }),
        ));
    }

    let info: GoogleTokenInfo = res.json().await.map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            Json(ErrorResponse {
                error: "Failed to parse Google response".into(),
            }),
        )
    })?;

    // Validate audience matches our client ID
    if info.aud.as_deref() != Some(GOOGLE_CLIENT_ID) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Token audience mismatch".into(),
            }),
        ));
    }

    if info.email_verified.as_deref() != Some("true") {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Email not verified".into(),
            }),
        ));
    }

    let email = info.email.unwrap_or_default();
    let name = info.name.unwrap_or_default();
    let picture = info.picture.unwrap_or_default();

    // Create JWT
    let claims = Claims {
        sub: email.clone(),
        name: name.clone(),
        email: email.clone(),
        picture: picture.clone(),
        exp: (Utc::now().timestamp() + 86400 * 7) as usize, // 7 days
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(JWT_SECRET.as_bytes()),
    )
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Failed to create token".into(),
            }),
        )
    })?;

    Ok(Json(AuthResponse {
        token,
        name,
        email,
        picture,
    }))
}

async fn verify_token(
    headers: HeaderMap,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    let claims = extract_claims(&headers)?;
    Ok(Json(AuthResponse {
        token: String::new(),
        name: claims.name,
        email: claims.email,
        picture: claims.picture,
    }))
}

fn extract_claims(
    headers: &HeaderMap,
) -> Result<Claims, (StatusCode, Json<ErrorResponse>)> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "Missing authorization header".into(),
                }),
            )
        })?;

    decode_jwt(auth)
}

fn decode_jwt(token: &str) -> Result<Claims, (StatusCode, Json<ErrorResponse>)> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(JWT_SECRET.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Invalid or expired token".into(),
            }),
        )
    })?;

    Ok(data.claims)
}

// ─── ICE Servers Handler ─────────────────────────────────────────────────────

async fn ice_servers() -> Json<IceServersResponse> {
    let mut servers = vec![
        IceServerEntry {
            urls: "stun:stun.l.google.com:19302".into(),
            username: None,
            credential: None,
        },
        IceServerEntry {
            urls: "stun:stun1.l.google.com:19302".into(),
            username: None,
            credential: None,
        },
    ];

    if let (Ok(url), Ok(user), Ok(pass)) = (
        std::env::var("TURN_SERVER_URL"),
        std::env::var("TURN_USERNAME"),
        std::env::var("TURN_PASSWORD"),
    ) {
        servers.push(IceServerEntry {
            urls: format!("turn:{}", url),
            username: Some(user),
            credential: Some(pass),
        });
    }

    Json(IceServersResponse { ice_servers: servers })
}

// ─── Room Handler ────────────────────────────────────────────────────────────

async fn create_room(
    headers: HeaderMap,
) -> Result<Json<CreateRoomResponse>, (StatusCode, Json<ErrorResponse>)> {
    // Verify auth
    extract_claims(&headers)?;
    let room_id = Uuid::new_v4().to_string()[..8].to_string();
    Ok(Json(CreateRoomResponse { room_id }))
}

// ─── WebSocket Handler ──────────────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsQuery>,
    State(rooms): State<RoomMap>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let room_id = params.room;
    let token = params.token;

    // Verify JWT from query param
    let claims = decode_jwt(&token)?;

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, room_id, claims, rooms)))
}

async fn handle_socket(socket: WebSocket, room_id: String, claims: Claims, rooms: RoomMap) {
    let user_id = claims.sub.clone();
    let name = claims.name.clone();
    let email = claims.email.clone();
    let picture = claims.picture.clone();

    // Ensure room exists
    rooms.entry(room_id.clone()).or_insert_with(|| {
        let (tx, _) = broadcast::channel(256);
        RoomState {
            tx,
            users: DashMap::new(),
        }
    });

    let room = rooms.get(&room_id).unwrap();
    room.users.insert(
        user_id.clone(),
        UserInfo {
            user_id: user_id.clone(),
            name: name.clone(),
            email: email.clone(),
            picture: picture.clone(),
        },
    );

    let tx = room.tx.clone();
    let mut rx = tx.subscribe();

    // Collect existing users for the joiner
    let existing_users: Vec<UserInfo> = room
        .users
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    drop(room);

    // Broadcast that this user joined
    let join_msg = serde_json::to_string(&WsMessage::UserJoined {
        user_id: user_id.clone(),
        name: name.clone(),
        picture: picture.clone(),
        users: existing_users,
    })
    .unwrap();
    let _ = tx.send(join_msg);

    let (mut ws_sender, mut ws_receiver) = socket.split();

    let tx_for_recv = tx.clone();

    // Task: forward broadcast messages to this client
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Task: receive messages from this client and broadcast/route
    let uid_recv = user_id.clone();
    let name_recv = name.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Close(_) => break,
                _ => continue,
            };

            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                let msg_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match msg_type {
                    "offer" | "answer" | "ice_candidate" | "cam_status" => {
                        let _ = tx_for_recv.send(text);
                    }
                    "chat" => {
                        let chat_msg = serde_json::to_string(&WsMessage::Chat {
                            from: uid_recv.clone(),
                            name: name_recv.clone(),
                            message: parsed
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("")
                                .to_string(),
                        })
                        .unwrap();
                        let _ = tx_for_recv.send(chat_msg);
                    }
                    _ => {
                        let _ = tx_for_recv.send(text);
                    }
                }
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    // Cleanup
    if let Some(room) = rooms.get(&room_id) {
        room.users.remove(&user_id);

        let leave_msg =
            serde_json::to_string(&WsMessage::UserLeft {
                user_id: user_id.clone(),
            })
            .unwrap();
        let _ = room.tx.send(leave_msg);

        if room.users.is_empty() {
            drop(room);
            rooms.remove(&room_id);
        }
    }

    println!("User {} left room {}", user_id, room_id);
}
