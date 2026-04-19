// ─── Auth Configuration ──────────────────────────────────────────────────────

const API_BASE = `${location.protocol}//${location.hostname}:8080`;
const GOOGLE_CLIENT_ID = "587752196180-tlu3l06kmtl2655sd6fpa74gm4ka2c3h.apps.googleusercontent.com";

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const loginScreen = $("loginScreen");
const dashboard = $("dashboard");
const loginError = $("loginError");
const userAvatar = $("userAvatar");
const userName = $("userName");
const logoutBtn = $("logoutBtn");
const createBtn = $("createBtn");
const joinBtn = $("joinBtn");
const roomInput = $("roomInput");

// ─── Session ─────────────────────────────────────────────────────────────────

function getSession() {
    try {
        const raw = localStorage.getItem("bro_meet_session");
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function setSession(data) {
    localStorage.setItem("bro_meet_session", JSON.stringify(data));
}

function clearSession() {
    localStorage.removeItem("bro_meet_session");
}

// ─── Init ────────────────────────────────────────────────────────────────────

(async function init() {
    const session = getSession();
    if (session && session.token) {
        // Verify token is still valid
        try {
            const res = await fetch(`${API_BASE}/api/auth/verify`, {
                headers: { Authorization: `Bearer ${session.token}` },
            });
            if (res.ok) {
                showDashboard(session);
                return;
            }
        } catch {}
        clearSession();
    }
    showLogin();
})();

// ─── Google Sign-In ──────────────────────────────────────────────────────────

function showLogin() {
    loginScreen.classList.remove("hidden");
    dashboard.classList.add("hidden");

    // Wait for Google Identity Services to load
    if (typeof google === "undefined" || !google.accounts) {
        window.addEventListener("load", initGoogleSignIn);
    } else {
        initGoogleSignIn();
    }
}

function initGoogleSignIn() {
    if (typeof google === "undefined" || !google.accounts) {
        setTimeout(initGoogleSignIn, 200);
        return;
    }
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCallback,
    });
    google.accounts.id.renderButton($("googleBtnWrap"), {
        theme: "outline",
        size: "large",
        width: 300,
        text: "signin_with",
    });
}

async function handleGoogleCallback(response) {
    loginError.classList.add("hidden");

    try {
        const res = await fetch(`${API_BASE}/api/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential: response.credential }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || "Authentication failed");
        }

        const data = await res.json();
        setSession(data);
        showDashboard(data);
    } catch (e) {
        loginError.textContent = e.message;
        loginError.classList.remove("hidden");
    }
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

function showDashboard(session) {
    loginScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    userAvatar.src = session.picture;
    userName.textContent = session.name;

    // Check if URL has /meet/ path
    const path = location.pathname;
    const match = path.match(/^\/meet\/([a-zA-Z0-9-]+)/);
    if (match) {
        goToMeeting(match[1]);
    }
}

logoutBtn.onclick = () => {
    clearSession();
    if (typeof google !== "undefined" && google.accounts) {
        google.accounts.id.disableAutoSelect();
    }
    location.reload();
};

createBtn.onclick = async () => {
    const session = getSession();
    if (!session) return;
    try {
        const res = await fetch(`${API_BASE}/api/create-room`, {
            headers: { Authorization: `Bearer ${session.token}` },
        });
        if (!res.ok) throw new Error("Failed to create room");
        const data = await res.json();
        goToMeeting(data.room_id);
    } catch (e) {
        alert(e.message);
    }
};

joinBtn.onclick = () => {
    const code = roomInput.value.trim();
    if (!code) { roomInput.focus(); return; }
    goToMeeting(code);
};

roomInput.onkeydown = (e) => {
    if (e.key === "Enter") joinBtn.onclick();
};

function goToMeeting(roomId) {
    window.location.href = `/meet/${roomId}`;
}
