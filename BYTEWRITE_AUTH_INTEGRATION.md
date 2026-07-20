# bytewrite ↔ bytenode 계정 연동 가이드 (Codex용)

bytewrite에서 별도 회원가입 없이 **bytenode(https://bytenode109.vercel.app) 계정으로 로그인**하게 만드는 방법입니다. bytenode 서버가 인증 서버 역할을 하고, bytewrite는 그 API를 그대로 호출하면 됩니다.

## 인증 방식 요약

- 방식: **JWT Bearer 토큰** (유효기간 30일)
- 발급: 로그인/회원가입 API가 `token`을 반환
- 사용: 이후 모든 요청에 헤더 `Authorization: Bearer <token>` 첨부
- 저장: bytenode 웹은 localStorage/sessionStorage 키 `bn_token`(토큰), `bn_me`(유저 JSON)를 사용 — bytewrite도 같은 키를 쓰면 나중에 두 서비스 간 세션 공유가 쉬움

Base URL: `https://bytenode109.vercel.app`

## API 엔드포인트

### 1. 로그인 — `POST /api/auth/login`

요청:
```json
{ "username": "아이디", "password": "비밀번호" }
```

성공(200) 응답:
```json
{
  "token": "eyJhbGciOi...",
  "user": { "id": "...", "username": "...", "displayName": "...", "isAdmin": false, "bio": "", "avatar": "" }
}
```

실패 시 `{ "error": "메시지" }` (400/401). 에러 메시지는 한국어이므로 그대로 UI에 표시하면 됨.

### 2. 회원가입 — `POST /api/auth/register`

요청:
```json
{ "username": "아이디", "displayName": "표시 이름", "password": "비밀번호(6~128자)" }
```

응답 형식은 로그인과 동일 (`token` + `user`).

### 3. 토큰 검증 / 내 정보 — `GET /api/auth/me`

헤더: `Authorization: Bearer <token>`

- 200 → 토큰 유효, 최신 유저 정보 반환
- 401/403 → 토큰 만료·무효 → 로그아웃 처리 후 재로그인 유도

**bytewrite 앱 시작 시 저장된 토큰으로 이 API를 한 번 호출해서 세션 유효성을 확인하는 것을 권장.**

### 4. 비밀번호 변경 — `PATCH /api/auth/password` (인증 필요)

```json
{ "currentPassword": "...", "newPassword": "..." }
```

## bytewrite 클라이언트 구현 예시 (JS)

```js
const BN_API = 'https://bytenode109.vercel.app';

async function login(username, password) {
  const r = await fetch(BN_API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '로그인 실패');
  localStorage.setItem('bn_token', data.token);
  localStorage.setItem('bn_me', JSON.stringify(data.user));
  return data.user;
}

async function checkSession() {
  const token = localStorage.getItem('bn_token');
  if (!token) return null;
  const r = await fetch(BN_API + '/api/auth/me', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) { localStorage.removeItem('bn_token'); localStorage.removeItem('bn_me'); return null; }
  return r.json();
}
```

## JWT 페이로드 구조 (참고)

토큰 안에는 `{ id, username, displayName, isAdmin }`가 들어 있고 서버의 `JWT_SECRET`으로 서명됨. **bytewrite에서 토큰을 직접 검증하려 하지 말 것** — 시크릿은 bytenode 서버에만 있으므로, 검증은 항상 `/api/auth/me` 호출로 할 것.

## 주의사항

1. **CORS**: bytenode 서버는 환경변수 `ALLOWED_ORIGINS`(쉼표 구분)로 허용 도메인을 제어함. 현재 미설정 시 모든 origin 허용. 만약 브라우저에서 CORS 에러가 나면 bytenode의 Vercel 환경변수 `ALLOWED_ORIGINS`에 bytewrite 도메인을 추가해야 함. 데스크톱 앱/서버사이드 호출이면 CORS 무관.
2. 비밀번호를 bytewrite에 절대 저장하지 말 것 — 토큰만 저장.
3. 토큰 만료(30일) 시 자동 갱신 API는 없음 → 재로그인 필요.
4. 로그아웃 = 클라이언트에서 `bn_token`/`bn_me` 삭제 (서버 무효화 API 없음).
