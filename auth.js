import { GOOGLE_CLIENT_ID, ALLOWED_EMAIL_HASHES, DRIVE_SCOPE } from './config.js?v=a72f8f4';

// initTokenClient(암묵적 흐름)에는 openid/email/profile 스코프를 함께 요청할 수 없다
// (구글 OAuth 정책 위반으로 로그인 자체가 거부된다). drive.file 하나만 요청하고,
// 로그인한 사람의 이메일은 Drive about API로 따로 확인한다.
const AUTH_SCOPE = DRIVE_SCOPE;

export class WrongAccountError extends Error {
  constructor(email) {
    super('WRONG_ACCOUNT');
    this.email = email;
  }
}

let tokenClient = null;
let accessToken = null;
let accessTokenExpiresAt = 0;
let userEmail = null;

function waitForGis() {
  return new Promise((resolve) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const timer = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

async function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  await waitForGis();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: AUTH_SCOPE,
    callback: () => {},
  });
  return tokenClient;
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    ensureTokenClient().then((client) => {
      client.callback = (resp) => {
        if (resp.error) {
          reject(new Error(resp.error));
          return;
        }
        accessToken = resp.access_token;
        accessTokenExpiresAt = Date.now() + Number(resp.expires_in) * 1000;
        resolve(accessToken);
      };
      client.requestAccessToken({ prompt });
    }, reject);
  });
}

async function fetchUserEmail(token) {
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('사용자 정보를 가져오지 못했습니다');
  const info = await res.json();
  return info.user.emailAddress;
}

// 공개 저장소에 실제 이메일 평문이 올라가지 않도록, 비교는 SHA-256 해시로만 한다
// (실제 접근 통제는 구글 OAuth 동의 화면의 테스트 사용자 목록이 이미 하고 있어서 충분하다).
async function hashEmail(email) {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 로그인 버튼 클릭 등 사용자 동작 안에서 호출해야 한다 (동의 창 팝업 필요). */
export async function signIn() {
  const token = await requestToken('consent');
  const email = await fetchUserEmail(token);
  if (!ALLOWED_EMAIL_HASHES.includes(await hashEmail(email))) {
    signOut();
    throw new WrongAccountError(email);
  }
  userEmail = email;
  return email;
}

export function getUserEmail() {
  return userEmail;
}

/**
 * 새로고침 직후 등, 이미 이 계정으로 동의한 적이 있으면 팝업 없이 조용히 다시 로그인을 시도한다.
 * (실패하면 null — 이 경우에만 "구글 계정으로 로그인" 화면을 보여주면 된다.)
 */
export async function tryResume() {
  try {
    const token = await requestToken('');
    const email = await fetchUserEmail(token);
    if (!ALLOWED_EMAIL_HASHES.includes(await hashEmail(email))) {
      signOut();
      return null;
    }
    userEmail = email;
    return email;
  } catch {
    return null;
  }
}

/** Drive API 호출 직전에 불러 쓰는 access token. 만료 임박 시 조용히 갱신을 시도한다. */
export async function ensureAccessToken() {
  const now = Date.now();
  if (accessToken && now < accessTokenExpiresAt - 60000) return accessToken;
  return requestToken('');
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  accessTokenExpiresAt = 0;
  userEmail = null;
}
