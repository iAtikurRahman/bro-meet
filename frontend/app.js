// ─── Configuration ────────────────────────────────────────────────────────────

const API_BASE = `${location.protocol}//${location.hostname}:8080`;
const WS_URL = location.protocol === "https:"
    ? `wss://${location.hostname}:8080/ws`
    : `ws://${location.hostname}:8080/ws`;

let ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];

// Fetch ICE server config (including TURN) from backend
fetch(`${API_BASE}/api/ice-servers`)
    .then((r) => r.json())
    .then((data) => { if (data.ice_servers) ICE_SERVERS = data.ice_servers; })
    .catch(() => { /* keep defaults on error */ });

const USERS_PER_PAGE = 6;

// ─── Session Check ───────────────────────────────────────────────────────────

function getSession() {
    try {
        const raw = localStorage.getItem("bro_meet_session");
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

const session = getSession();
if (!session || !session.token) {
    window.location.href = "/";
}

// ─── State ───────────────────────────────────────────────────────────────────

let localStream = null;
let screenStream = null;
let ws = null;
let myUserId = session ? session.email : "";
let myName = session ? session.name : "";
let myPicture = session ? session.picture : "";
let currentRoom = "";
let micOn = true;
let camOn = true;
let currentPage = 0;
let focusedUserId = null; // null = grid view, string = focused user
let isFullscreen = false;

// All participants: { id, name, picture, stream, pc, camOn }
// "local" is always first
const participants = [];
const peers = {}; // userId -> { pc, stream }
const camStatus = {}; // userId -> boolean

// ─── DOM Elements ────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const videoGrid = $("videoGrid");
const focusView = $("focusView");
const focusMain = $("focusMain");
const focusTile = $("focusTile");
const focusSidebar = $("focusSidebar");
const fullscreenBtn = $("fullscreenBtn");
const exitFocusBtn = $("exitFocusBtn");
const roomInfo = $("roomInfo");
const copyLink = $("copyLink");
const pageInfo = $("pageInfo");
const prevPage = $("prevPage");
const nextPage = $("nextPage");
const micBtn = $("micBtn");
const camBtn = $("camBtn");
const screenBtn = $("screenBtn");
const chatToggle = $("chatToggle");
const leaveBtn = $("leaveBtn");
const chatPanel = $("chatPanel");
const chatClose = $("chatClose");
const chatMessages = $("chatMessages");
const msgInput = $("msgInput");
const sendMsg = $("sendMsg");
const toastContainer = $("toastContainer");

// ─── Extract room ID from URL ────────────────────────────────────────────────

(function init() {
    const match = location.pathname.match(/^\/meet\/([a-zA-Z0-9-]+)/);
    if (!match) {
        window.location.href = "/";
        return;
    }
    currentRoom = match[1];
    roomInfo.textContent = `Room: ${currentRoom}`;
    startMeeting();
})();

// ─── Start Meeting ───────────────────────────────────────────────────────────

async function startMeeting() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
            audio: { echoCancellation: true, noiseSuppression: true },
        });
    } catch (e) {
        alert("Camera/mic access denied. Please allow and retry.");
        window.location.href = "/";
        return;
    }

    camStatus["local"] = true;

    // Add self as first participant
    participants.push({
        id: "local",
        name: myName + " (You)",
        picture: myPicture,
        stream: localStream,
    });

    renderGrid();
    connectWebSocket();
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

function connectWebSocket() {
    const url = `${WS_URL}?room=${encodeURIComponent(currentRoom)}&token=${encodeURIComponent(session.token)}`;
    ws = new WebSocket(url);

    ws.onopen = () => console.log("WS connected");

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
    };

    ws.onclose = () => console.log("WS disconnected");
    ws.onerror = (e) => console.error("WS error:", e);
}

function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

// ─── Message Handling ────────────────────────────────────────────────────────

function handleWsMessage(msg) {
    switch (msg.type) {
        case "user_joined": handleUserJoined(msg); break;
        case "user_left": handleUserLeft(msg); break;
        case "offer": handleOffer(msg); break;
        case "answer": handleAnswer(msg); break;
        case "ice_candidate": handleIceCandidate(msg); break;
        case "chat": handleChat(msg); break;
        case "cam_status": handleCamStatus(msg); break;
    }
}

function handleUserJoined(msg) {
    if (msg.user_id === myUserId) return;

    // Avoid duplicates
    if (!peers[msg.user_id]) {
        showToast(`${msg.name} joined`);
        createPeerConnection(msg.user_id, msg.name, msg.picture, true);
    }
}

function handleUserLeft(msg) {
    const peer = peers[msg.user_id];
    const pIdx = participants.findIndex((p) => p.id === msg.user_id);
    const pName = pIdx >= 0 ? participants[pIdx].name : msg.user_id;
    showToast(`${pName} left`);
    removePeer(msg.user_id);
}

async function handleOffer(msg) {
    if (msg.to !== myUserId) return;
    if (!peers[msg.from]) {
        createPeerConnection(msg.from, "", "", false);
    }
    const pc = peers[msg.from].pc;
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: msg.sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: "answer", from: myUserId, to: msg.from, sdp: answer.sdp });
}

async function handleAnswer(msg) {
    if (msg.to !== myUserId) return;
    const peer = peers[msg.from];
    if (peer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
    }
}

async function handleIceCandidate(msg) {
    if (msg.to !== myUserId) return;
    const peer = peers[msg.from];
    if (peer && msg.candidate) {
        try {
            await peer.pc.addIceCandidate(JSON.parse(msg.candidate));
        } catch (e) {
            console.warn("ICE candidate error:", e);
        }
    }
}

function handleChat(msg) {
    appendChatMessage(msg.name, msg.message, msg.from === myUserId);
}

function handleCamStatus(msg) {
    if (msg.user_id === myUserId) return;
    camStatus[msg.user_id] = msg.enabled;
    renderGrid();
}

// ─── WebRTC Peer Management ─────────────────────────────────────────────────

function createPeerConnection(remoteUserId, remoteName, remotePicture, isCaller) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (localStream) {
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            wsSend({
                type: "ice_candidate",
                from: myUserId,
                to: remoteUserId,
                candidate: JSON.stringify(event.candidate),
            });
        }
    };

    const remoteStream = new MediaStream();
    pc.ontrack = (event) => {
        remoteStream.addTrack(event.track);
        // Update existing participant or add new
        const existing = participants.find((p) => p.id === remoteUserId);
        if (existing) {
            existing.stream = remoteStream;
        } else {
            participants.push({
                id: remoteUserId,
                name: remoteName || remoteUserId,
                picture: remotePicture || "",
                stream: remoteStream,
            });
        }
        camStatus[remoteUserId] = camStatus[remoteUserId] !== false;
        renderGrid();
    };

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
            removePeer(remoteUserId);
        }
    };

    peers[remoteUserId] = { pc, stream: remoteStream };

    // Add participant placeholder
    if (!participants.find((p) => p.id === remoteUserId)) {
        participants.push({
            id: remoteUserId,
            name: remoteName || remoteUserId,
            picture: remotePicture || "",
            stream: remoteStream,
        });
        camStatus[remoteUserId] = true;
        renderGrid();
    }

    if (isCaller) {
        pc.createOffer()
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => {
                wsSend({
                    type: "offer",
                    from: myUserId,
                    to: remoteUserId,
                    sdp: pc.localDescription.sdp,
                });
            });
    }

    return pc;
}

function removePeer(userId) {
    const peer = peers[userId];
    if (peer) {
        peer.pc.close();
        delete peers[userId];
    }
    delete camStatus[userId];

    const idx = participants.findIndex((p) => p.id === userId);
    if (idx >= 0) participants.splice(idx, 1);

    if (focusedUserId === userId) {
        focusedUserId = null;
        isFullscreen = false;
    }

    renderGrid();
}

// ─── Grid Rendering with Pagination ──────────────────────────────────────────

function renderGrid() {
    if (focusedUserId !== null) {
        renderFocusView();
        return;
    }

    // Show grid view, hide focus view
    videoGrid.classList.remove("hidden");
    focusView.classList.add("hidden");

    const totalPages = Math.max(1, Math.ceil(participants.length / USERS_PER_PAGE));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    if (currentPage < 0) currentPage = 0;

    const start = currentPage * USERS_PER_PAGE;
    const pageParticipants = participants.slice(start, start + USERS_PER_PAGE);

    videoGrid.innerHTML = "";
    pageParticipants.forEach((p) => {
        const tile = createTileElement(p, false);
        tile.onclick = () => {
            focusedUserId = p.id;
            renderGrid();
        };
        videoGrid.appendChild(tile);
    });

    // Pagination controls
    if (totalPages > 1) {
        pageInfo.textContent = `${currentPage + 1} / ${totalPages}`;
        pageInfo.classList.remove("hidden");
        prevPage.classList.toggle("hidden", currentPage === 0);
        nextPage.classList.toggle("hidden", currentPage >= totalPages - 1);
    } else {
        pageInfo.classList.add("hidden");
        prevPage.classList.add("hidden");
        nextPage.classList.add("hidden");
    }
}

function createTileElement(participant, isSmall) {
    const tile = document.createElement("div");
    tile.className = isSmall ? "video-tile sidebar-tile" : "video-tile";
    tile.id = `tile-${participant.id}`;

    const isCamOn = participant.id === "local" ? camOn : (camStatus[participant.id] !== false);

    if (isCamOn && participant.stream) {
        const video = document.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        if (participant.id === "local") video.muted = true;
        video.srcObject = participant.stream;
        tile.appendChild(video);
    } else {
        // Show avatar
        const avatarWrap = document.createElement("div");
        avatarWrap.className = "avatar-wrap";
        if (participant.picture) {
            const img = document.createElement("img");
            img.src = participant.picture;
            img.className = "avatar-large";
            img.referrerPolicy = "no-referrer";
            avatarWrap.appendChild(img);
        } else {
            const initials = document.createElement("div");
            initials.className = "avatar-initials";
            initials.textContent = participant.name.charAt(0).toUpperCase();
            avatarWrap.appendChild(initials);
        }
        tile.appendChild(avatarWrap);
    }

    const label = document.createElement("div");
    label.className = "video-label";
    label.textContent = participant.name;
    tile.appendChild(label);

    return tile;
}

// ─── Focus View ──────────────────────────────────────────────────────────────

function renderFocusView() {
    videoGrid.classList.add("hidden");
    focusView.classList.remove("hidden");

    const focused = participants.find((p) => p.id === focusedUserId);
    if (!focused) {
        focusedUserId = null;
        renderGrid();
        return;
    }

    // Main focused tile
    focusTile.innerHTML = "";
    const mainTile = createTileElement(focused, false);
    mainTile.onclick = null; // no click on focused
    // Move children into focusTile
    while (mainTile.firstChild) {
        focusTile.appendChild(mainTile.firstChild);
    }

    // Fullscreen state
    if (isFullscreen) {
        focusSidebar.classList.add("hidden");
        fullscreenBtn.innerHTML = "&#9974; Exit Fullscreen";
    } else {
        focusSidebar.classList.remove("hidden");
        fullscreenBtn.innerHTML = "&#9974; Fullscreen";
    }

    // Sidebar: all other participants as small cards
    focusSidebar.innerHTML = "";
    if (!isFullscreen) {
        participants.forEach((p) => {
            if (p.id === focusedUserId) return;
            const tile = createTileElement(p, true);
            tile.onclick = () => {
                focusedUserId = p.id;
                renderGrid();
            };
            focusSidebar.appendChild(tile);
        });
    }

    // Hide pagination in focus view
    pageInfo.classList.add("hidden");
    prevPage.classList.add("hidden");
    nextPage.classList.add("hidden");
}

// ─── Focus/Fullscreen Controls ───────────────────────────────────────────────

exitFocusBtn.onclick = () => {
    focusedUserId = null;
    isFullscreen = false;
    renderGrid();
};

fullscreenBtn.onclick = () => {
    isFullscreen = !isFullscreen;
    renderGrid();
};

// ─── Pagination Controls ─────────────────────────────────────────────────────

prevPage.onclick = () => {
    if (currentPage > 0) {
        currentPage--;
        renderGrid();
    }
};

nextPage.onclick = () => {
    const totalPages = Math.ceil(participants.length / USERS_PER_PAGE);
    if (currentPage < totalPages - 1) {
        currentPage++;
        renderGrid();
    }
};

// ─── Controls ────────────────────────────────────────────────────────────────

micBtn.onclick = () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    micBtn.classList.toggle("off", !micOn);
    micBtn.innerHTML = micOn ? "&#127908; Mic" : "&#128263; Muted";
};

camBtn.onclick = () => {
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    camBtn.classList.toggle("off", !camOn);
    camBtn.innerHTML = camOn ? "&#127909; Cam" : "&#128248; Off";
    camStatus["local"] = camOn;

    // Broadcast cam status
    wsSend({ type: "cam_status", user_id: myUserId, enabled: camOn });

    renderGrid();
};

screenBtn.onclick = async () => {
    if (screenStream) {
        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;
        const camTrack = localStream.getVideoTracks()[0];
        replaceTrackInPeers(camTrack);
        screenBtn.classList.remove("active");
        // Restore local stream
        const localP = participants.find((p) => p.id === "local");
        if (localP) localP.stream = localStream;
        renderGrid();
        return;
    }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        replaceTrackInPeers(screenTrack);
        screenBtn.classList.add("active");

        // Update local participant stream the screen
        const localP = participants.find((p) => p.id === "local");
        if (localP) localP.stream = screenStream;
        renderGrid();

        screenTrack.onended = () => {
            screenStream = null;
            const camTrack = localStream.getVideoTracks()[0];
            replaceTrackInPeers(camTrack);
            screenBtn.classList.remove("active");
            if (localP) localP.stream = localStream;
            renderGrid();
        };
    } catch (e) {
        console.log("Screen share cancelled");
    }
};

function replaceTrackInPeers(newTrack) {
    for (const userId in peers) {
        const sender = peers[userId].pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) sender.replaceTrack(newTrack);
    }
}

leaveBtn.onclick = () => {
    // Close all peers
    for (const userId in peers) {
        peers[userId].pc.close();
        delete peers[userId];
    }

    if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;
    }

    if (ws) {
        ws.close();
        ws = null;
    }

    window.location.href = "/";
};

// ─── Chat ────────────────────────────────────────────────────────────────────

chatToggle.onclick = () => chatPanel.classList.toggle("hidden");
chatClose.onclick = () => chatPanel.classList.add("hidden");

sendMsg.onclick = sendChatMessage;
msgInput.onkeydown = (e) => {
    if (e.key === "Enter") sendChatMessage();
};

function sendChatMessage() {
    const text = msgInput.value.trim();
    if (!text) return;
    wsSend({ type: "chat", message: text });
    msgInput.value = "";
}

function appendChatMessage(name, text, isMine) {
    const div = document.createElement("div");
    div.className = `chat-msg ${isMine ? "mine" : ""}`;
    div.innerHTML = `<strong>${escapeHtml(name)}</strong>: ${escapeHtml(text)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// ─── Copy Link ───────────────────────────────────────────────────────────────

copyLink.onclick = () => {
    const url = `${location.origin}/meet/${currentRoom}`;
    navigator.clipboard.writeText(url).then(() => {
        copyLink.textContent = "✓ Copied!";
        setTimeout(() => (copyLink.innerHTML = "&#128279; Copy Link"), 2000);
    });
};

// ─── Toast Notifications ─────────────────────────────────────────────────────

function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add("fade-out");
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}
