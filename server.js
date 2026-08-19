'use strict';
require('dotenv').config();

const express      = require('express');
const path         = require('path');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const cors         = require('cors');
const multer       = require('multer');
const admin        = require('firebase-admin');
const fetch        = require('node-fetch');

/* ── Firebase 초기화 ── */
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app  = express();
const PORT = process.env.PORT || 4000;
const PUB  = path.join(__dirname, 'public');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET 없음'); process.exit(1); }
const ADMIN_PW = process.env.ADMIN_PW;
if (!ADMIN_PW) { console.error('ADMIN_PW 없음'); process.exit(1); }

/* ── 관리자 계정 초기화 ── */
async function initAdmin() {
  const snap = await db.collection('users').where('username', '==', 'studioztec').limit(1).get();
  const hashed = await bcrypt.hash(ADMIN_PW, 12);
  if (snap.empty) {
    const id = uuid();
    await db.collection('users').doc(id).set({
      username: 'studioztec', displayName: '관리자', pw: hashed,
      isAdmin: true, bio: '', avatar: '', banned: false,
      bannedReason: '', createdAt: Date.now()
    });
    console.log('관리자 계정 생성 완료');
  } else {
    await snap.docs[0].ref.update({ pw: hashed });
    console.log('관리자 비번 업데이트 완료');
  }
}
initAdmin().catch(e => console.error('관리자 초기화 실패', e));

/* ── 챗봇 FAQ 기본 데이터 시드 ── */
async function seedChatbotFaqs() {
  const snap = await db.collection('chatbot_faqs').limit(1).get();
  if (!snap.empty) return; // 이미 데이터 있으면 스킵

  const DEFAULT_FAQS = [
    /* ── bytenode 기본 ── */
    {
      question: 'AI가 생성한 코드를 붙여넣었는데 아무것도 안 나와요',
      answer: 'AI가 코드 블록(```...```) 안에 감싸서 출력했을 가능성이 높아요. 코드 블록 안의 내용만 복사해서 붙여넣어 보세요. 또는 AI에게 "코드 블록 없이 태그만 바로 출력해줘"라고 다시 요청해보세요.',
      followUps: [
        { question: '그래도 아무것도 안 나와요', answer: '태그 안에 > 문자가 있으면 파서가 그 위치에서 태그를 닫아버려요. 태그 내용에 꺾쇠(>)가 없는지 확인해보세요. 수식 부등호는 \\gt로 써야 해요.' },
        { question: 'AI가 마크다운(##, **)으로 글을 써요', answer: '프롬프트를 먼저 붙여넣은 뒤, 그 다음 메시지로 주제를 알려주세요. 또는 AI에게 "bytenode 태그만 사용해서 다시 써줘"라고 요청하면 돼요.' },
      ]
    },
    {
      question: '태그 안에 꺾쇠(>) 문자를 써야 하는데 이상해져요',
      answer: 'bytenode 태그는 > 를 태그 닫힘으로 인식해요. 부등호가 필요한 경우 수식에서는 \\gt (크다) / \\lt (작다)를 사용하세요. 일반 텍스트에서는 꺾쇠 대신 다른 표현(예: "이상", "초과")으로 쓰는 게 좋아요.',
      followUps: [
        { question: '태그 중첩은 되나요?', answer: '태그 중첩은 지원되지 않아요. <indent: <mark: 내용>> 같은 형식은 동작하지 않아요. 대신 <indent:>와 <mark:>를 각각 따로 줄에 써주세요.' },
      ]
    },
    {
      question: '링크는 어떻게 넣어요?',
      answer: '{URL} 링크문구 형식으로 써요. 예: {https://google.com} 구글 바로가기. Markdown의 [텍스트](URL) 형식은 사용하지 않아요.',
      followUps: [
        { question: '링크가 새 탭에서 안 열려요', answer: 'bytenode 링크는 기본적으로 새 탭(target=_blank)으로 열려요. 링크 형식이 정확한지 확인해보세요. URL 앞뒤에 공백이 없어야 해요.' },
      ]
    },
    {
      question: '이미지 업로드는 됐는데 글에서 안 보여요',
      answer: '업로드만 하면 자동으로 들어가지 않아요. 글 본문에 <img: /uploads/파일명.jpg> 태그를 직접 써야 해요. 업로드 후 나타나는 파일 경로를 복사해서 사용하세요.',
      followUps: [
        { question: '이미지 크기를 조절하고 싶어요', answer: '<img: /uploads/파일명.jpg | 600px> 처럼 너비를 두 번째 인자로 넣을 수 있어요. 기본은 100% 너비예요.' },
        { question: '이미지가 업로드 자체가 안 돼요', answer: '지원 형식은 jpg, png, gif, webp, svg예요. 파일 크기가 너무 크면 업로드가 실패할 수 있어요. 5MB 이하로 줄여서 다시 시도해보세요.' },
      ]
    },
    {
      question: '여러 이미지를 갤러리처럼 보여주고 싶어요',
      answer: '<gallery: /uploads/a.jpg /uploads/b.jpg /uploads/c.jpg> 형식으로 쓰면 이미지들이 갤러리 그리드로 표시돼요. 클릭하면 슬라이드쇼로 확대 보기도 돼요.',
      followUps: [
        { question: '이미지 순서를 바꾸고 싶어요', answer: 'gallery 태그 안의 파일 경로 순서를 바꾸면 돼요. 왼쪽부터 순서대로 표시됩니다.' },
        { question: '동영상도 넣을 수 있어요?', answer: '<video: /uploads/파일명.mp4> 태그로 동영상을 넣을 수 있어요. mp4, webm, mov 형식을 지원해요.' },
      ]
    },
    {
      question: '수학 수식이 안 나와요',
      answer: '인라인 수식은 $수식$, 블록(독립 줄) 수식은 $$수식$$ 형식으로 써요. 수식 안에 > < 부등호가 있다면 \\gt, \\lt로 바꿔야 해요.',
      followUps: [
        { question: '분수, 제곱근 같은 기호는 어떻게 써요?', answer: '분수: $\\frac{분자}{분모}$, 제곱근: $\\sqrt{x}$, 지수: $x^{2}$, 아래첨자: $x_{n}$. LaTeX 문법을 그대로 사용해요.' },
        { question: 'AI가 수식을 이상하게 써요', answer: 'AI에게 "수식은 반드시 $...$ 또는 $$...$$로 감싸줘"라고 명시해서 요청하면 더 정확하게 출력해줘요. 또는 bytenode 프롬프트를 먼저 복사해서 붙여넣고 요청하세요.' },
      ]
    },
    {
      question: '화학식은 어떻게 써요?',
      answer: '$\\ce{화학식}$ 형식으로 써요. 예: $\\ce{H2O}$, $\\ce{CH4 + 2O2 -> CO2 + 2H2O}$. 화살표는 -> 또는 --> 로 쓰면 됩니다.',
      followUps: [
        { question: '구조식(SMILES)도 표현할 수 있어요?', answer: 'byteexam에서는 [SMILES:c1ccccc1] 형식으로 구조식을 자동 렌더링할 수 있어요. bytenode 본문에서는 현재 SMILES 직접 렌더링은 지원하지 않아요.' },
        { question: '이온식, 반응식도 되나요?', answer: '네, $\\ce{Na+ + Cl- -> NaCl}$, $\\ce{2H2 + O2 -> 2H2O}$ 처럼 이온식, 반응식 모두 \\ce{} 안에 그대로 쓰면 돼요.' },
      ]
    },
    {
      question: '표는 어떻게 만들어요?',
      answer: '<table: 헤더1|헤더2|헤더3 // 행1값1|행1값2|행1값3 // 행2값1|행2값2|행2값3> 형식으로 써요. // 로 행을 구분하고, | 로 열을 구분해요.',
      followUps: [
        { question: '표에 색상을 넣고 싶어요', answer: 'PPT 모드에서는 <xtable: 헤더1|헤더2 // 값1|값2 | head:#1e40af | stripe:#0f172a> 형식의 고급 표를 쓸 수 있어요. head, stripe, border 색상을 각각 지정할 수 있어요.' },
        { question: '셀 글자 색을 바꾸고 싶어요', answer: 'xtable에서 셀 값 뒤에 ::#색코드 를 추가하면 돼요. 예: +200%::#4ade80 → +200% 글자가 초록색으로 표시돼요.' },
      ]
    },
    {
      question: '글 수정·삭제는 어떻게 해요?',
      answer: '내 게시물을 클릭하면 오른쪽 상단에 ✏️ 수정 버튼이 나타나요. 누르면 코드 에디터가 열리고, 수정 후 저장하면 됩니다. 삭제는 수정 화면 하단의 🗑 삭제 버튼을 이용하세요.',
      followUps: [
        { question: '수정 버튼이 안 보여요', answer: '본인이 작성한 글에만 수정 버튼이 표시돼요. 로그인 상태인지 확인하고, 다른 사람의 글이면 수정할 수 없어요.' },
      ]
    },
    {
      question: '글자 크기를 바꾸고 싶어요',
      answer: '<1t:> ~ <9t:> 태그로 크기를 지정해요. 숫자가 클수록 글자가 커요. 예: <7t: 큰 제목>, <4t: 본문 텍스트>. <xt:> 는 자동 강조 제목이에요.',
      followUps: [
        { question: '굵게, 기울임은 어떻게 해요?', answer: '<bt: 텍스트> 는 굵게(bold), <it: 텍스트> 는 기울임(italic), <mark: 텍스트> 는 형광 표시예요.' },
      ]
    },
    /* ── PPT ── */
    {
      question: 'PPT 슬라이드가 한 장만 나오고 나머지가 안 보여요',
      answer: 'AI가 <slide:> 태그 대신 --- 구분선이나 숫자(1., 2.)로 슬라이드를 나눴을 가능성이 높아요. bytenode-ppt에서는 오직 <slide:>와 <slidecover:> 태그만이 슬라이드를 구분해요. 프롬프트를 다시 복사해서 AI에 붙여넣고 재생성하세요.',
      followUps: [
        { question: '프롬프트는 어디서 복사해요?', answer: '글쓰기 → bytenode-ppt 1e 모드 선택 → "AI 프롬프트 복사" 버튼을 눌러주세요. 또는 상단 메뉴 "프롬프트"에서도 찾을 수 있어요.' },
        { question: 'AI가 어떤 주제인지 안 물어보고 바로 슬라이드를 써요', answer: 'AI가 첫 메시지로 주제를 물어보는 게 정상이에요. 만약 바로 만들었다면 프롬프트를 먼저 붙여넣은 뒤 주제를 따로 메시지로 입력해보세요.' },
      ]
    },
    {
      question: 'PPT에 배경색이나 그라데이션을 넣고 싶어요',
      answer: '<slide:> 태그 바로 아래에 <slidebg: 배경스펙>을 써요. 단색: <slidebg: #1e3a8a>, 그라데이션: <slidebg: gradient|#0f172a|#7c3aed>, 패턴: <slidebg: circuit|rgba(96,165,250,.2)|#0a0f1e> 등을 사용할 수 있어요.',
      followUps: [
        { question: '슬라이드 전체가 아닌 일부만 색칠하고 싶어요', answer: '<freebox: 0,0,45,100,0> 태그 안에 <bgblock: #1e3a8a> 를 첫 번째로 넣으면 그 박스 영역만 색칠돼요. Canva의 분할 배경과 똑같이 만들 수 있어요.' },
        { question: '메시 그라데이션(빛번짐) 효과는 어떻게 해요?', answer: '<meshbg: #0f172a | #1e3a8a | #581c87 | #020617> 를 슬라이드 안에 쓰면 돼요. slidebg와 함께 쓰면 배경이 더 풍부해져요.' },
      ]
    },
    {
      question: 'freebox(자유 배치)를 어떻게 사용해요?',
      answer: '<freebox: x, y, w, h, z> 로 박스를 열고 내용 태그들을 쓴 뒤 <endbox> 로 닫아요. x/y/w/h는 0~100 기준 비율이에요. 예: <freebox: 10, 20, 40, 30, 1> → 왼쪽 10%, 위 20% 위치에 너비 40%, 높이 30% 박스.',
      followUps: [
        { question: '박스들이 서로 겹쳐요', answer: 'z 값이 큰 박스가 위에 올라와요. 겹침을 원하지 않는다면 x+w ≤ 95, y+h ≤ 95 를 지키고, 나란히 놓는 박스는 왼쪽 x+w가 오른쪽 x보다 5 이상 작게 설정하세요.' },
        { question: 'freebox 배경에 색을 넣고 싶어요', answer: 'freebox 안의 첫 번째 태그로 <bgblock: #색코드> 를 쓰면 그 박스의 배경색이 돼요. <bgsplit: v|45%|#색1|#색2> 를 쓰면 좌우 분할 배경도 만들 수 있어요.' },
      ]
    },
    {
      question: '슬라이드에서 특정 글자만 색을 바꾸고 싶어요',
      answer: '텍스트 태그 안에서 <c: #색코드 | 글자> 로 특정 단어에 색을 지정할 수 있어요. 예: <bt: <c: #38bdf8 | AI>는 세상을 바꾼다>. 그라데이션은 <gc: #색1,#색2 | 글자>를 사용해요.',
      followUps: [
        { question: '여러 단어를 한 줄에 각각 다른 색으로 쓰고 싶어요', answer: '<colortext: #f00:빨간단어 | 일반단어 | #0af:파란단어> 형식을 쓰면 돼요. 색 지정 없는 항목은 기본 색으로 표시돼요.' },
        { question: '빛번짐 글로우 텍스트는 어떻게 해요?', answer: '<textglow: #38bdf8,#a78bfa | 핵심 키워드 | 8> 형식으로 써요. 숫자는 크기(1~9)이고, 글자에 색과 빛번짐 효과가 동시에 적용돼요.' },
      ]
    },
    {
      question: 'PPT에서 고급 표(xtable)는 어떻게 써요?',
      answer: '<xtable: 헤더1|헤더2|헤더3 // 행1|행2|행3 // 행1|행2|행3 | head:#1e40af | stripe:#0f172a | border:#444> 형식이에요. // 로 행 구분, | 로 열 구분, head/stripe/border로 색상을 지정해요.',
      followUps: [
        { question: '특정 셀 글자 색을 바꾸고 싶어요', answer: '셀 값 뒤에 ::#색코드 를 추가해요. 예: +200%::#4ade80 → 글자가 초록색으로 표시돼요.' },
      ]
    },
    {
      question: 'PPT 슬라이드에 차트를 어떻게 넣어요?',
      answer: '<piechart:>, <barchart:>, <linechart:>, <stat:> 등 차트 태그를 슬라이드 내용으로 그냥 쓰면 돼요. 예: <piechart: A:30 | B:45 | C:25 title:시장 점유율>.',
      followUps: [
        { question: '차트 크기를 바꾸고 싶어요', answer: '태그 끝에 size:small, size:medium, size:large 중 하나를 추가하면 돼요. 예: <barchart: 2020:120 | 2021:200 | 2022:350 size:large>.' },
        { question: '차트 제목은 어떻게 넣어요?', answer: '태그 뒤에 title:내용 을 추가해요. 예: <linechart: 1월:12 | 2월:18 | 3월:25 title:월별 방문자수>.' },
      ]
    },
    {
      question: '발표자 노트는 어떻게 넣어요?',
      answer: '<slidenote: 발표 시 참고할 메모 내용> 을 슬라이드 내용 아무 곳에나 써요. 슬라이드 하단에 작은 글씨로 표시되고, PDF 출력 시에도 포함돼요.',
      followUps: [
        { question: '노트가 PDF에서 안 보여요', answer: '브라우저 인쇄 시 "배경 그래픽 인쇄" 옵션을 켜고 출력해보세요. PDF 저장 버튼을 사용하면 자동으로 포함돼요.' },
      ]
    },
    {
      question: '모바일에서 PPT가 이상하게 보여요',
      answer: 'freebox 자유 배치 레이아웃은 모바일에서 세로 스택으로 재배치돼요. 이는 의도된 동작이에요. 원래 16:9 레이아웃은 PC 화면 또는 PDF로 저장할 때 정상 표시됩니다.',
      followUps: [
        { question: 'partition을 쓰면 모바일에서도 예쁘게 나오나요?', answer: '<partition: 50-50 | 16px> 같은 구조적 분할은 모바일에서도 반응형으로 세로 스택 변환이 돼요. freebox보다 모바일 호환성이 높아요.' },
      ]
    },
    {
      question: 'AI가 PPT 프롬프트를 받은 뒤 수학 풀이나 일반 설명을 해요',
      answer: 'bytenode-ppt 프롬프트를 붙여넣은 뒤, AI가 "어떤 주제로 PPT를 만들까요?"라고 물어보면 그때 주제를 알려주세요. 순서가 맞지 않거나 다른 대화 중간에 프롬프트를 넣으면 AI가 일반 답변 모드로 응답할 수 있어요.',
      followUps: [
        { question: '주제를 줬는데도 태그가 아닌 일반 글로 써요', answer: 'AI에게 "bytenode-ppt 태그만 사용해서 코드 블록 없이 바로 출력해줘"라고 다시 요청해보세요. ChatGPT보다 Claude나 Gemini에서 더 잘 작동하는 경우도 있어요.' },
        { question: '슬라이드가 10장 이상 필요해요', answer: '처음 요청 시 "슬라이드 15장으로 구성해줘"처럼 장수를 명시하면 돼요. 이미 만들어진 코드에 슬라이드를 추가하려면 AI에게 특정 슬라이드 뒤에 추가해달라고 요청하세요.' },
      ]
    },
    {
      question: 'PPT 슬라이드에 수식을 넣고 싶어요',
      answer: '슬라이드 안에서도 $수식$ 인라인 수식과 $$수식$$ 블록 수식을 그대로 쓸 수 있어요. 예: <bt: 공식: $E = mc^2$>.',
      followUps: [
        { question: 'freebox 안에서 수식이 안 나와요', answer: 'freebox 내부에서도 수식이 정상 작동해요. 혹시 > 문자가 수식에 포함돼 있다면 \\gt로 바꿔주세요.' },
        { question: '수식이 포함된 슬라이드 PDF가 깨져요', answer: 'PDF 저장 버튼 대신 Ctrl+P → PDF로 저장을 시도해보세요. 수식 렌더링 라이브러리가 완전히 로드된 뒤 저장하는 게 좋아요.' },
      ]
    },
    /* ── Canva 스타일 태그 ── */
    {
      question: '3단 컬럼(columns3) 태그는 어떻게 써요?',
      answer: '<columns3: 내용1 | 내용2 | 내용3> 형식으로 써요. 세 칸이 동일한 너비로 가로로 나란히 배치돼요. 비교·특징 나열 슬라이드에 적합해요.',
      followUps: [
        { question: '2단 컬럼은요?', answer: '<columns2: 왼쪽내용 | 오른쪽내용> 을 쓰면 돼요. 비율 조정은 지원하지 않고, 50-50으로 나뉘어요. 비율이 필요하면 <partition: 30-70 | 16px>을 사용하세요.' },
      ]
    },
    {
      question: '2×2 정보 그리드(grid2x2) 태그는 어떻게 써요?',
      answer: '<grid2x2: 제목1:설명1 | 제목2:설명2 | 제목3:설명3 | 제목4:설명4 | accent:#38bdf8> 형식으로 써요. 각 셀은 제목:설명 구조이고 accent로 상단 강조색을 지정해요.',
      followUps: [
        { question: '셀이 4개 미만이어도 되나요?', answer: '4개 미만을 입력하면 나머지 셀은 빈 박스로 채워져요. 2개나 3개만 쓰고 싶다면 grid2x2보다 columns3나 columns2가 더 어울려요.' },
        { question: 'accent 색을 안 쓰면 어떻게 돼요?', answer: 'accent 생략 시 기본 파란색(#60a5fa)으로 강조색이 적용돼요.' },
      ]
    },
    {
      question: 'A vs B 비교표(comparison) 태그는 어떻게 써요?',
      answer: '<comparison: A라벨 | B라벨 // 항목1 | A값1 | B값1 // 항목2 | A값2 | B값2> 형식이에요. // 로 행을 구분하고, 첫 행이 A/B 헤더가 돼요.',
      followUps: [
        { question: '비교 항목이 10개 이상이에요', answer: '항목 수 제한은 없어요. // 를 계속 추가해서 행을 늘릴 수 있어요. 다만 슬라이드 한 장에 너무 많은 행을 넣으면 가독성이 떨어지니 5~7개 내외를 추천해요.' },
      ]
    },
    {
      question: '포스트잇 메모(annotate) 태그는 어떻게 써요?',
      answer: '<annotate: 메모 내용 | #fbbf24> 형식이에요. 두 번째 인자가 배경색이에요. 노란색(#fbbf24)이 기본이고, 원하는 색으로 바꿀 수 있어요.',
      followUps: [
        { question: '어디에 쓰면 좋아요?', answer: '보충 설명, 주의사항, "잠깐!" 같은 짧은 메모에 적합해요. freebox 안에 넣으면 슬라이드 특정 위치에 포스트잇처럼 배치할 수 있어요.' },
      ]
    },
    {
      question: '매거진 레이아웃(magazine) 태그는 어떻게 써요?',
      answer: '<magazine: /uploads/이미지.jpg | 제목 | 설명 내용 | left> 형식이에요. 이미지와 텍스트가 가로로 나란히 배치돼요. 마지막 인자(left/right)로 이미지 위치를 바꿀 수 있어요.',
      followUps: [
        { question: '이미지 없이 텍스트만 넣으면 어떻게 돼요?', answer: '이미지 URL을 빈 값으로 두면 텍스트만 표시돼요. 하지만 이 경우 그냥 <bt:>나 <5t:>를 쓰는 게 더 깔끔해요.' },
      ]
    },
    /* ── 인포그래픽 ── */
    {
      question: '차트(barchart, piechart 등)가 아무것도 안 나와요',
      answer: '차트 태그는 bytegraphic 1e 또는 bytenode-ppt 1e 모드에서만 작동해요. 글쓰기 시 모드를 올바르게 선택했는지 확인하세요. bytenode 1(기본) 모드에서는 차트가 렌더링되지 않아요.',
      followUps: [
        { question: '모드는 어디서 바꿔요?', answer: '글쓰기 버튼을 누르면 모드 선택 화면이 나와요. 이미 작성 중이라면 에디터 상단의 모드 드롭다운에서 변경할 수 있어요.' },
        { question: '지원하는 차트 종류가 뭐예요?', answer: 'piechart, donut, barchart, hbar, linechart, areachart, radar, funnel, pyramid, gauge, bubbles, versus 등 12종 이상의 차트를 지원해요. 코드 설명서에서 전체 목록을 확인하세요.' },
      ]
    },
    {
      question: '파이차트 각 항목 색상을 바꾸고 싶어요',
      answer: '각 항목 뒤에 :색코드를 붙이면 돼요. 예: <piechart: 사과:35:#ef4444 | 바나나:25:#fbbf24 | 포도:40:#a78bfa title:과일 비율>.',
      followUps: [
        { question: '항목 수가 너무 많아요', answer: '항목이 6개 이상이면 파이차트보다 barchart나 hbar(가로 막대)가 가독성이 더 좋아요. 항목이 많을 때는 "기타"로 묶는 것도 방법이에요.' },
      ]
    },
    {
      question: '통계 수치(stat) 태그는 어떻게 써요?',
      answer: '<stat: 수치 | 라벨 | 색> 형식이에요. 예: <stat: 4,200만 | AI 서비스 사용자 | #60a5fa>. 큰 숫자를 강조해서 보여주는 KPI 카드예요.',
      followUps: [
        { question: 'stat을 여러 개 나란히 보이고 싶어요', answer: 'stat 태그를 여러 줄 연속으로 쓰면 자동으로 가로로 나란히 배치돼요. 3개 이하일 때 가장 보기 좋아요.' },
      ]
    },
    {
      question: '진행도 막대(progress bar)는 어떻게 써요?',
      answer: '<progress: 라벨 | 값% | 색> 형식이에요. 예: <progress: 프로젝트 완료율 | 75% | #4ade80>. 여러 줄 쓰면 아래로 나열돼요.',
      followUps: [
        { question: '100% 이상의 값을 표시할 수 있어요?', answer: '값은 0~100% 사이로 써야 해요. 100% 초과 값은 100%로 클램핑돼요. 목표 대비 달성률 같은 경우에는 gauge 태그를 고려해보세요.' },
      ]
    },
    {
      question: '인포그래픽 결과물을 PDF로 저장하고 싶어요',
      answer: '게시물 상단의 PDF 버튼을 누르거나 Ctrl+P → PDF로 저장을 선택하세요. 인포그래픽 모드는 지정한 출력 비율(A4/16:9 등)에 맞게 레이아웃이 조정돼요.',
      followUps: [
        { question: '출력 비율은 어디서 바꿔요?', answer: '에디터 상단에 비율 선택 드롭다운이 있어요. 16:9(발표), A4(인쇄), 1:1(정사각) 등을 선택할 수 있어요.' },
      ]
    },
    /* ── byteexam ── */
    {
      question: 'byteexam 시험지가 저장이 안 돼요',
      answer: 'AI 코드에서 ---BYTEEXAM-START--- 부터 ---BYTEEXAM-END--- 사이의 내용만 정확히 복사해야 해요. 그 바깥의 AI 설명 텍스트가 섞이면 파싱 오류가 나요.',
      followUps: [
        { question: '마커를 포함해서 복사해야 하나요?', answer: 'START/END 마커는 포함해도 되고 안 해도 돼요. 파서가 마커를 자동으로 인식해서 제거하고 내용만 처리해요.' },
        { question: '저장은 됐는데 문제가 깨져서 나와요', answer: 'type= 필드가 올바른지 확인해보세요. 객관식은 type=5choice, 보기형은 type=5choice_with_bogi, 단답형은 type=short, 서술형은 type=essay 예요.' },
      ]
    },
    {
      question: 'byteexam 문제에서 수식이 이상하게 나와요',
      answer: '수식이 $...$ 또는 $$...$$ 로 감싸져 있는지 확인하세요. AI가 $ 기호를 빠뜨리거나, \\frac{a}{b} 대신 a/b 로 썼을 수 있어요.',
      followUps: [
        { question: 'AI에게 수식을 정확하게 쓰라고 하는 방법이 있어요?', answer: '프롬프트를 붙여넣을 때 "수식은 반드시 LaTeX 형식 $...$ 으로 써줘"라고 명시적으로 요청해보세요. byteexam 전용 프롬프트 생성기를 쓰면 이미 이 지시가 포함돼 있어요.' },
        { question: '분수식이 인라인으로 작게 나와요', answer: '$$\\frac{a}{b}$$ 처럼 $$ 두 개로 감싸면 블록(독립 줄)으로 크게 표시돼요. 선택지 안의 수식은 $...$ 인라인이 더 자연스러워요.' },
      ]
    },
    {
      question: 'ㄱ,ㄴ,ㄷ 보기형 문제는 어떻게 만들어요?',
      answer: 'type=5choice_with_bogi 로 설정하고, bogi_1=ㄱ. 내용, bogi_2=ㄴ. 내용, bogi_3=ㄷ. 내용 을 추가하면 돼요. 선택지는 "ㄱ만 옳다", "ㄱ,ㄴ 옳다" 형식으로 구성해요.',
      followUps: [
        { question: 'AI 프롬프트 생성기에서 보기형을 선택하면 자동으로 나오나요?', answer: '네, byteexam 프롬프트 생성기에서 문제 유형을 "5지선다(보기형)" 으로 선택하면 AI가 자동으로 bogi_ 필드를 포함한 코드를 생성해줘요.' },
      ]
    },
    {
      question: '문제 배점은 어떻게 설정해요?',
      answer: '각 문제 블록에 point=배점 를 추가하면 돼요. 예: point=3 → 3점짜리 문제. 배점은 2, 3, 4, 5 중 하나를 주로 사용하고, 시험 총점에 맞게 조정하세요.',
      followUps: [
        { question: '배점 합계가 자동으로 계산되나요?', answer: '현재 자동 합계 표시 기능은 없어요. 각 문제의 point= 값을 직접 더해서 총점을 확인하세요.' },
      ]
    },
    {
      question: 'byteexam 시험지를 PDF로 저장하고 싶어요',
      answer: '시험지 상단의 "PDF 다운로드" 버튼을 누르면 A4 2단 레이아웃으로 자동 저장돼요. 또는 Ctrl+P → PDF로 저장도 가능해요. 문제가 페이지 경계에서 잘리지 않도록 자동으로 배치돼요.',
      followUps: [
        { question: '정답과 해설을 제외하고 인쇄하고 싶어요', answer: '시험지 보기 화면에서 "정답/해설 숨기기" 옵션을 켜고 PDF로 저장하면 학생 배부용 시험지가 만들어져요.' },
      ]
    },
    /* ── 계정/인증 ── */
    {
      question: '회원가입이 안 돼요',
      answer: '아이디는 영문 소문자와 숫자만 사용 가능하고, 비밀번호는 최소 6자 이상이어야 해요. 이미 사용 중인 아이디라면 다른 아이디로 시도해보세요.',
      followUps: [
        { question: '아이디 형식이 맞는데도 안 돼요', answer: '브라우저의 자동완성이 잘못된 값을 입력했을 수 있어요. 모든 칸을 직접 지우고 다시 입력해보세요. 그래도 안 되면 다른 브라우저로 시도해보세요.' },
        { question: '가입된 계정이 없는지 확인하려면요?', answer: '로그인 창에서 내 아이디로 로그인을 시도해보세요. "사용자를 찾을 수 없음" 오류가 나오면 계정이 없는 거고, 비밀번호 오류가 나오면 이미 가입된 계정이에요.' },
      ]
    },
    {
      question: '로그인이 안 돼요',
      answer: '아이디와 비밀번호가 정확한지 확인해보세요. 대소문자도 구분하니 주의하세요. 비밀번호가 기억나지 않으면 관리자에게 초기화를 요청해야 해요.',
      followUps: [
        { question: '아이디를 잊어버렸어요', answer: '현재 아이디 찾기 기능은 없어요. 처음 가입할 때 사용한 아이디를 기억해보거나, 새 계정을 만들어야 할 수 있어요.' },
        { question: '로그인해도 바로 로그아웃 돼요', answer: '브라우저의 쿠키나 로컬스토리지가 차단돼 있으면 세션이 유지되지 않아요. 브라우저 설정에서 쿠키 허용 여부를 확인해보세요.' },
      ]
    },
    {
      question: '비밀번호를 바꾸고 싶어요',
      answer: '로그인 후 오른쪽 상단 프로필 → 설정(⚙)에서 비밀번호 변경이 가능해요. 현재 비밀번호를 먼저 입력한 뒤 새 비밀번호를 설정하면 됩니다.',
      followUps: [
        { question: '현재 비밀번호가 기억나지 않아요', answer: '현재 비밀번호 없이는 변경할 수 없어요. 관리자에게 비밀번호 초기화를 요청하는 방법밖에 없어요.' },
      ]
    },
    {
      question: 'byteexam도 bytenode 계정으로 로그인하는 거예요?',
      answer: '네, byteexam과 bytenode는 같은 계정을 공유해요. bytenode에서 사용하는 아이디와 비밀번호로 byteexam에 그대로 로그인하면 됩니다.',
      followUps: [
        { question: 'byteexam 주소는 어떻게 돼요?', answer: 'bytenode 상단 메뉴의 "byteexam" 링크를 클릭하거나, byteexam109.vercel.app 으로 직접 접속하면 돼요.' },
        { question: 'bytenode와 byteexam에서 만든 자료가 연동되나요?', answer: '현재 자료는 연동되지 않아요. bytenode 게시물은 bytenode에, byteexam 시험지는 byteexam에 각각 따로 저장돼요.' },
      ]
    },
    {
      question: '닉네임이나 프로필 사진을 바꾸고 싶어요',
      answer: '로그인 후 상단 오른쪽 프로필 → 설정에서 닉네임과 프로필 사진(아바타 URL)을 변경할 수 있어요.',
      followUps: [
        { question: '프로필 사진으로 직접 찍은 사진을 쓰고 싶어요', answer: '먼저 bytenode에 이미지를 업로드한 뒤, 그 이미지 경로(/uploads/파일명.jpg)를 아바타 URL 칸에 입력하면 돼요.' },
      ]
    },
  ];

  const batch = db.batch();
  DEFAULT_FAQS.forEach((faq, i) => {
    const ref = db.collection('chatbot_faqs').doc();
    batch.set(ref, { ...faq, order: (i + 1) * 1000, createdAt: Date.now() });
  });
  await batch.commit();
  console.log(`챗봇 FAQ ${DEFAULT_FAQS.length}개 기본 데이터 시드 완료`);
}
seedChatbotFaqs().catch(e => console.error('챗봇 FAQ 시드 실패', e));

/* ── 미들웨어 ── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      /* 인라인 <script> 블록을 외부 파일로 분리해 'unsafe-inline'을 뺐다.
       주입된 <script>는 이제 실행되지 않는다. onclick 속성 핸들러가 185곳 남아
       script-src-attr에만 예외를 둔다. CDN 스크립트는 전부 SRI로 무결성 검증. */
      scriptSrc: ["'self'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "ajax.googleapis.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:", "*.public.blob.vercel-storage.com"],
      mediaSrc: ["'self'", "blob:", "*.public.blob.vercel-storage.com"],
      connectSrc: ["'self'", "https://bytenode-account.vercel.app"],
      objectSrc: ["'none'"],
      workerSrc: ["blob:"]
    }
  }
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS: origin not allowed'));
  }
}));
app.use((req, res, next) => {
  if (req.path === '/api/posts' && req.method === 'POST') express.json({ limit: '2mb' })(req, res, next);
  else express.json({ limit: '512kb' })(req, res, next);
});
app.use(express.static(PUB));

const limiter     = rateLimit({ windowMs: 5*60*1000, max: 300 });
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: '너무 많은 시도입니다. 15분 후 다시 시도하세요.' } });
app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

/* ── multer + Vercel Blob ── */
const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|ogg)|model\/(gltf-binary|gltf\+json))$/;
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => ALLOWED_MIME.test(file.mimetype) ? cb(null, true) : cb(new Error('허용되지 않는 파일 형식입니다.')),
  limits: { fileSize: 50 * 1024 * 1024 }
});
const AVATAR_MIME = /^image\/(jpeg|png|webp)$/;
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => AVATAR_MIME.test(file.mimetype) ? cb(null, true) : cb(new Error('PNG, JPG, WEBP 이미지만 사용할 수 있습니다.')),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }
}).single('avatar');

function acceptAvatar(req, res, next) {
  avatarUpload(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '프로필 이미지는 2MB 이하여야 합니다.' });
    }
    return res.status(400).json({ error: err.message || '프로필 이미지를 확인할 수 없습니다.' });
  });
}

async function uploadToBlob(file) {
  const { put } = require('@vercel/blob');
  const extMap = { 'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp','image/avif':'.avif','video/mp4':'.mp4','video/webm':'.webm','video/ogg':'.ogv','model/gltf-binary':'.glb','model/gltf+json':'.gltf' };
  const ext = extMap[file.mimetype] || '.bin';
  const blob = await put(uuid() + ext, file.buffer, { access: 'public' });
  return blob.url;
}

async function deleteStoredBlob(url) {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('.public.blob.vercel-storage.com')) return;
    const { del } = require('@vercel/blob');
    await del(url);
  } catch (e) {
    console.error('[blob delete]', e.message);
  }
}

/* ── 토큰 무효화(revoke) 지원 ──
   각 유저 문서의 tokenVersion(tv)과 JWT의 tv 클레임을 대조. 불일치 시 거부.
   비번 변경·"모든 기기 로그아웃"·정지 시 tv를 올리면 기존 토큰 전부 무효화됨.
   과도한 읽기를 막기 위해 tv를 30초 캐시(무효화는 최대 30초 내 전파). */
const _tvCache = new Map();
async function currentTokenVersion(userId) {
  const c = _tvCache.get(userId);
  if (c && Date.now() < c.exp) return c.tv;
  const doc = await db.collection('users').doc(userId).get();
  const tv = doc.exists ? (doc.data().tokenVersion || 0) : 0;
  _tvCache.set(userId, { tv, exp: Date.now() + 30000 });
  return tv;
}
function bumpTokenVersion(userId) {
  _tvCache.delete(userId);
  return db.collection('users').doc(userId).update({
    tokenVersion: admin.firestore.FieldValue.increment(1)
  });
}

/* ── JWT 미들웨어 ── */
async function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: '인증이 필요합니다.' });
  let payload;
  try { payload = jwt.verify(h.slice(7), JWT_SECRET); }
  catch { return res.status(401).json({ error: '만료되었거나 잘못된 토큰입니다.' }); }
  try {
    /* 구 토큰(tv 없음)은 0으로 간주 → 기존 세션 유지, 이후 bump로 무효화 가능 */
    let cur = await currentTokenVersion(payload.id);
    if ((payload.tv || 0) !== cur) {
      /* 캐시는 인스턴스마다 따로다. 다른 인스턴스에서 tokenVersion이 오른 직후에는
         방금 정상 발급된 토큰이 이 인스턴스의 30초 캐시와 어긋나 거부됐다.
         불일치하면 캐시를 버리고 원본을 다시 확인한 뒤에만 거부한다. */
      _tvCache.delete(payload.id);
      cur = await currentTokenVersion(payload.id);
      if ((payload.tv || 0) !== cur) return res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인하세요.' });
    }
  } catch { /* 조회 실패 시 가용성 우선: 통과 */ }
  req.user = payload;
  next();
}
async function adminOnly(req, res, next) {
  try {
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists || !doc.data().isAdmin) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    next();
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
}
function mapUser(id, d) {
  if (!d) return null;
  return { id, _id: id, username: d.username, displayName: d.displayName||'', pw: d.pw, isAdmin: d.isAdmin||false, bio: d.bio||'', avatar: d.avatar||'', banned: d.banned||false, bannedReason: d.bannedReason||'', accountType: d.accountType||'', tokenVersion: d.tokenVersion||0, createdAt: d.createdAt };
}

/* ══ AUTH ══ */

/* 아이디 사용 가능 여부(가입 마법사에서 실시간 중복 검사용). 공개 엔드포인트. */
app.get('/api/auth/username-available', async (req, res) => {
  try {
    const u = String(req.query.u || '').trim();
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(u)) return res.status(400).json({ available: false, error: '아이디 형식이 올바르지 않습니다.' });
    const ex = await db.collection('users').where('username', '==', u).limit(1).get();
    res.json({ available: ex.empty });
  } catch (e) { res.status(500).json({ available: false, error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, displayName, password } = req.body;
    if (!username||!displayName||!password) return res.status(400).json({ error: '모든 필드를 입력하세요.' });
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: '아이디는 영문·숫자·_만 3~30자로 입력하세요.' });
    if (displayName.length < 1 || displayName.length > 30) return res.status(400).json({ error: '닉네임은 1~30자여야 합니다.' });
    if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '비밀번호는 6~128자여야 합니다.' });
    const existing = await db.collection('users').where('username', '==', username).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    const hashed = await bcrypt.hash(password, 12);
    const id = uuid();
    await db.collection('users').doc(id).set({ username, displayName, pw: hashed, isAdmin: false, bio: '', avatar: '', banned: false, bannedReason: '', tokenVersion: 0, createdAt: Date.now() });
    const token = jwt.sign({ id, username, displayName, isAdmin: false, tv: 0 }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, username, displayName, isAdmin: false, bio: '', avatar: '', accountType: '' } });
  } catch(e) { console.error('[register]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* 계정별 로그인 시도 제한 (Firestore 기반 → 서버리스 다중 인스턴스에서도 유효).
   IP가 아닌 username 기준이라 SSO 프록시로 IP가 뭉쳐도, 분산 공격이어도 방어됨. */
const LOGIN_MAX = 8, LOGIN_WINDOW = 15 * 60 * 1000;
async function loginThrottle(username) {
  const ref = db.collection('loginAttempts').doc(String(username).toLowerCase().slice(0, 60));
  return db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    const now = Date.now();
    let d = doc.exists ? doc.data() : { count: 0, first: now };
    if (now - d.first > LOGIN_WINDOW) d = { count: 0, first: now };  /* 창 만료 → 리셋 */
    if (d.count >= LOGIN_MAX) return { blocked: true, retryMs: LOGIN_WINDOW - (now - d.first) };
    tx.set(ref, { count: d.count + 1, first: d.first });
    return { blocked: false };
  });
}
async function loginReset(username) {
  try { await db.collection('loginAttempts').doc(String(username).toLowerCase().slice(0, 60)).delete(); } catch {}
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    const gate = await loginThrottle(username);
    if (gate.blocked) return res.status(429).json({ error: `로그인 시도가 너무 많습니다. ${Math.ceil(gate.retryMs/60000)}분 후 다시 시도하세요.` });
    const snap = await db.collection('users').where('username', '==', username).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    const docSnap = snap.docs[0];
    const user = mapUser(docSnap.id, docSnap.data());
    const ok = await bcrypt.compare(password, user.pw);
    if (!ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    if (user.banned) return res.status(403).json({ error: '정지된 계정입니다.', banned: true, bannedReason: user.bannedReason||'관리자에 의해 정지됨' });
    await loginReset(username);   /* 성공 시 시도 카운터 초기화 */
    const token = jwt.sign({ id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin, tv: user.tokenVersion }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin, bio: user.bio, avatar: user.avatar, accountType: user.accountType } });
  } catch(e) { console.error('[login]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    const u = mapUser(doc.id, doc.data());
    res.json({ id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin, bio: u.bio, avatar: u.avatar, accountType: u.accountType });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/auth/me', auth, async (req, res) => {
  try {
    const { displayName, bio } = req.body;
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    const upd = {};
    if (displayName) upd.displayName = displayName;
    if (bio !== undefined) upd.bio = bio;
    await db.collection('users').doc(req.user.id).update(upd);
    res.json({ ok: true });
  } catch(e) { console.error('[patch me]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/auth/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword||!newPassword) return res.status(400).json({ error: '현재·새 비밀번호를 입력하세요.' });
    if (newPassword.length < 6 || newPassword.length > 128) return res.status(400).json({ error: '새 비밀번호는 6~128자여야 합니다.' });
    const doc = await db.collection('users').doc(req.user.id).get();
    const user = mapUser(doc.id, doc.data());
    const ok = await bcrypt.compare(currentPassword, user.pw);
    if (!ok) return res.status(401).json({ error: '현재 비밀번호가 틀렸습니다.' });
    const hashed = await bcrypt.hash(newPassword, 12);
    /* 비번 변경 시 기존 세션 전부 무효화(tv 증가) 후, 현재 기기용 새 토큰 발급 */
    await db.collection('users').doc(req.user.id).update({ pw: hashed });
    await bumpTokenVersion(req.user.id);
    const newTv = (user.tokenVersion || 0) + 1;
    const token = jwt.sign({ id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin, tv: newTv }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token });
  } catch(e) { console.error('[password]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* 모든 기기에서 로그아웃 — 이 계정의 기존 토큰 전부 즉시 무효화, 현재 기기만 새 토큰 */
app.post('/api/auth/logout-all', auth, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    const u = mapUser(doc.id, doc.data());
    await bumpTokenVersion(req.user.id);
    const token = jwt.sign({ id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin, tv: (u.tokenVersion||0) + 1 }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token });
  } catch(e) { console.error('[logout-all]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/auth/avatar', auth, acceptAvatar, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
    const ref = db.collection('users').doc(req.user.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    const oldUrl = doc.data().avatar || '';
    const url = await uploadToBlob(req.file);
    try {
      await ref.update({ avatar: url });
    } catch (e) {
      await deleteStoredBlob(url);
      throw e;
    }
    await deleteStoredBlob(oldUrl);
    res.json({ url });
  } catch(e) { console.error('[avatar]', e); res.status(500).json({ error: '업로드 실패' }); }
});

app.delete('/api/auth/me', auth, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    const user = mapUser(doc.id, doc.data());
    if (user.username !== username) return res.status(401).json({ error: '아이디가 틀렸습니다.' });
    const ok = await bcrypt.compare(password, user.pw);
    if (!ok) return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
    if (user.isAdmin) return res.status(400).json({ error: '관리자 계정은 탈퇴할 수 없습니다.' });
    const batch = db.batch();
    const postSnap = await db.collection('posts').where('authorId', '==', user.id).get();
    postSnap.docs.forEach(d => batch.delete(d.ref));
    const examSnap = await db.collection('qf_exams').where('userId', '==', user.id).get();
    examSnap.docs.forEach(d => batch.delete(d.ref));
    const beSnap = await db.collection('be_exams').where('userId', '==', user.id).get();
    beSnap.docs.forEach(d => batch.delete(d.ref));
    const repSnap = await db.collection('reports').where('reporterId', '==', user.id).get();
    repSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection('users').doc(user.id));
    await batch.commit();
    res.json({ ok: true });
  } catch(e) { console.error('[delete me]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ POSTS ══ */

app.get('/api/posts', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)||1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit)||20));
    const snap  = await db.collection('posts').where('published','==',true).where('isPrivate','==',false).get();
    const all   = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b)=>b.createdAt-a.createdAt);
    const total = all.length;
    const paged = all.slice((page-1)*limit, page*limit);
    const result = await Promise.all(paged.map(async p => {
      const uDoc = await db.collection('users').doc(p.authorId).get();
      const u = uDoc.exists ? uDoc.data() : {};
      return { id: p.id, title: p.title, coverImage: p.coverImage||'', tags: p.tags||[], createdAt: p.createdAt, updatedAt: p.updatedAt, username: u.username||'', displayName: u.displayName||'(탈퇴)', avatar: u.avatar||'' };
    }));
    res.json({ posts: result, total, page, limit });
  } catch(e) { console.error('[get posts]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/posts/mine', auth, async (req, res) => {
  try {
    const snap = await db.collection('posts').where('authorId','==',req.user.id).get();
    const posts = snap.docs.map(d => { const p = d.data(); return { id: d.id, title: p.title, coverImage: p.coverImage||'', tags: p.tags||[], isPrivate: p.isPrivate, published: p.published, createdAt: p.createdAt, updatedAt: p.updatedAt }; }).sort((a,b)=>b.createdAt-a.createdAt);
    res.json({ posts, total: posts.length, limit: 50 });
  } catch(e) { console.error('[mine]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const doc = await db.collection('posts').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    const p = doc.data();
    if (p.isPrivate) {
      const token = req.headers.authorization?.slice(7);
      if (!token) return res.status(403).json({ error: '비공개 글입니다.' });
      try {
        const user = jwt.verify(token, JWT_SECRET);
        if (user.id !== p.authorId && !user.isAdmin) return res.status(403).json({ error: '비공개 글입니다.' });
      } catch { return res.status(403).json({ error: '비공개 글입니다.' }); }
    }
    const uDoc = await db.collection('users').doc(p.authorId).get();
    const u = uDoc.exists ? uDoc.data() : {};
    res.json({ id: doc.id, authorId: p.authorId, title: p.title, body: p.body, tags: p.tags||[], coverImage: p.coverImage||'', published: p.published, isPrivate: p.isPrivate, createdAt: p.createdAt, updatedAt: p.updatedAt, username: u.username||'', displayName: u.displayName||'(탈퇴)', avatar: u.avatar||'' });
  } catch(e) { console.error('[get post]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/posts', auth, async (req, res) => {
  try {
    const { title, body, tags, coverImage, published, isPrivate } = req.body;
    if (!title||!body) return res.status(400).json({ error: '제목과 내용을 입력하세요.' });
    const snap = await db.collection('posts').where('authorId','==',req.user.id).get();
    if (snap.size >= 50) return res.status(400).json({ error: '개인 저장소 한도(50개)에 도달했습니다.' });
    const now = Date.now(); const id = uuid();
    await db.collection('posts').doc(id).set({ authorId: req.user.id, title, body, tags: Array.isArray(tags)?tags:[], coverImage: coverImage||'', published: published!==false, isPrivate: !!isPrivate, createdAt: now, updatedAt: now });
    res.json({ id });
  } catch(e) { console.error('[create post]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/posts/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('posts').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    const p = doc.data();
    if (p.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: '권한이 없습니다.' });
    const { title, body, tags, coverImage, published, isPrivate } = req.body;
    const upd = { updatedAt: Date.now() };
    if (title !== undefined) upd.title = title;
    if (body !== undefined) upd.body = body;
    if (Array.isArray(tags)) upd.tags = tags;
    if (coverImage !== undefined) upd.coverImage = coverImage;
    if (published !== undefined) upd.published = published;
    if (isPrivate !== undefined) upd.isPrivate = !!isPrivate;
    await db.collection('posts').doc(req.params.id).update(upd);
    res.json({ ok: true });
  } catch(e) { console.error('[patch post]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('posts').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    if (doc.data().authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: '권한이 없습니다.' });
    await db.collection('posts').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { console.error('[delete post]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/upload/image', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
    const url = await uploadToBlob(req.file);
    res.json({ url });
  } catch(e) { console.error('[upload image]', e); res.status(500).json({ error: '업로드 실패' }); }
});

/* ══ NOTICES ══ */

app.get('/api/notices', async (req, res) => {
  try {
    const snap = await db.collection('notices').where('active','==',true).where('isBanner','==',false).get();
    res.json(snap.docs.map(d => { const n = d.data(); return { id: d.id, title: n.title, body: n.body, createdAt: n.createdAt }; }).sort((a,b)=>b.createdAt-a.createdAt));
  } catch(e) { console.error('[notices]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/notices', auth, adminOnly, async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title||!body) return res.status(400).json({ error: '제목과 내용을 입력하세요.' });
    const id = uuid();
    await db.collection('notices').doc(id).set({ title, body, isBanner: false, active: true, createdAt: Date.now() });
    res.json({ id });
  } catch(e) { console.error('[create notice]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/notices/banner', async (req, res) => {
  try {
    const snap = await db.collection('notices').where('active','==',true).where('isBanner','==',true).get();
    if (snap.empty) return res.json(null);
    const sorted = snap.docs.sort((a,b)=>b.data().createdAt-a.data().createdAt);
    const d = sorted[0]; const n = d.data();
    /* 클라이언트가 30초마다 확인하므로 짧게 캐시해 Firestore 읽기를 줄인다 */
    res.set('Cache-Control', 'public, max-age=20');
    res.json({ id: d.id, message: n.message, createdAt: n.createdAt });
  } catch(e) { console.error('[notices/banner]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/notices/banner', auth, adminOnly, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: '배너 문구를 입력하세요.' });
    const id = uuid();
    await db.collection('notices').doc(id).set({ message, isBanner: true, active: true, createdAt: Date.now() });
    res.json({ id });
  } catch(e) { console.error('[create banner]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/notices/regular', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('notices').where('isBanner','==',false).get();
    res.json(snap.docs.map(d => { const n = d.data(); return { id: d.id, title: n.title, body: n.body, active: n.active, createdAt: n.createdAt }; }).sort((a,b)=>b.createdAt-a.createdAt));
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/notices/banner', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('notices').where('isBanner','==',true).get();
    res.json(snap.docs.map(d => { const n = d.data(); return { id: d.id, message: n.message, active: n.active, createdAt: n.createdAt }; }).sort((a,b)=>b.createdAt-a.createdAt));
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/notices/:id', auth, adminOnly, async (req, res) => {
  try {
    const doc = await db.collection('notices').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '공지를 찾을 수 없습니다.' });
    await db.collection('notices').doc(req.params.id).update({ active: !!req.body.active });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/notices/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('notices').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ REPORTS ══ */

app.post('/api/reports', auth, async (req, res) => {
  try {
    const { postId, authorId, reason } = req.body;
    if (!postId || !reason) return res.status(400).json({ error: 'postId와 reason이 필요합니다.' });
    const existing = await db.collection('reports').where('postId','==',postId).where('reporterId','==',req.user.id).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: '이미 신고한 글입니다.' });
    await db.collection('reports').doc(uuid()).set({ postId, authorId: authorId||null, reporterId: req.user.id, reason: reason.trim().slice(0,300), createdAt: Date.now(), checked: false });
    res.json({ ok: true });
  } catch(e) { console.error('[reports]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/reports', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('reports').orderBy('createdAt','desc').get();
    const result = await Promise.all(snap.docs.map(async d => {
      const r = d.data();
      const pDoc = await db.collection('posts').doc(r.postId).get();
      const aDoc = r.authorId ? await db.collection('users').doc(r.authorId).get() : null;
      const rDoc = await db.collection('users').doc(r.reporterId).get();
      return { id: d.id, postId: r.postId, postTitle: pDoc.exists?pDoc.data().title:'(삭제된 글)', authorUsername: aDoc?.exists?aDoc.data().username:'', authorDisplayName: aDoc?.exists?aDoc.data().displayName:'(탈퇴)', reporterUsername: rDoc.exists?rDoc.data().username:'', reason: r.reason, createdAt: r.createdAt, checked: r.checked };
    }));
    res.json(result);
  } catch(e) { console.error('[admin/reports]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/admin/reports/:id', auth, adminOnly, async (req, res) => {
  try {
    const doc = await db.collection('reports').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '없음' });
    await db.collection('reports').doc(req.params.id).update({ checked: !doc.data().checked });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/admin/reports/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('reports').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ PROMPTS ══ */

app.get('/api/prompts', async (req, res) => {
  try {
    const snap = await db.collection('prompts').orderBy('createdAt','desc').get();
    res.json(snap.docs.map(d => { const p = d.data(); return { id: d.id, codeName: p.codeName, version: p.version||'', note: p.note||'', content: p.content, createdAt: p.createdAt }; }));
  } catch(e) { console.error('[prompts]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/admin/prompts', auth, adminOnly, async (req, res) => {
  try {
    const { codeName, version, note, content } = req.body;
    if (!codeName||!content) return res.status(400).json({ error: 'codeName과 content가 필요합니다.' });
    const id = uuid();
    await db.collection('prompts').doc(id).set({ codeName: codeName.trim(), version: (version||'').trim(), note: (note||'').trim(), content: String(content).slice(0,200000).trim(), createdAt: Date.now() });
    res.json({ ok: true, id });
  } catch(e) { console.error('[create prompt]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/admin/prompts/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('prompts').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ ADMIN USERS ══ */

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('createdAt','desc').get();
    const result = await Promise.all(snap.docs.map(async d => {
      const u = d.data();
      const [pSnap, eSnap, beSnap] = await Promise.all([
        db.collection('posts').where('authorId','==',d.id).get(),
        db.collection('qf_exams').where('userId','==',d.id).get(),
        db.collection('be_exams').where('userId','==',d.id).get()
      ]);
      return { id: d.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin||false, banned: u.banned||false, bannedReason: u.bannedReason||'', accountType: u.accountType||'', createdAt: u.createdAt, postCount: pSnap.size, examCount: eSnap.size, beExamCount: beSnap.size };
    }));
    res.json(result);
  } catch(e) { console.error('[admin/users]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* 계정 유형 분류: ''(일반) | 'class'(학급특색사업) | 'scivill'(동아리) | 'dshs'(대신고) */
app.post('/api/admin/account-type', auth, adminOnly, async (req, res) => {
  try {
    const { id, type } = req.body || {};
    if (!id) return res.status(400).json({ error: '대상 ID 필요' });
    if (!['', 'class', 'scivill', 'dshs'].includes(type)) return res.status(400).json({ error: '유형은 class, scivill, dshs 또는 빈 값이어야 합니다.' });
    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저 없음' });
    await db.collection('users').doc(id).update({ accountType: type });
    res.json({ ok: true });
  } catch(e) { console.error('[account-type]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/admin/ban', auth, adminOnly, async (req, res) => {
  try {
    const { id, reason } = req.body;
    if (!id) return res.status(400).json({ error: '대상 ID 필요' });
    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저 없음' });
    if (doc.data().isAdmin) return res.status(400).json({ error: '관리자는 정지할 수 없습니다.' });
    await db.collection('users').doc(id).update({ banned: true, bannedReason: (reason||'').trim().slice(0,200)||'관리자에 의해 정지됨', bannedAt: Date.now() });
    await bumpTokenVersion(id);   /* 정지 즉시 기존 세션 전부 무효화 */
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/admin/unban', auth, adminOnly, async (req, res) => {
  try {
    const { id } = req.body;
    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저 없음' });
    await db.collection('users').doc(id).update({ banned: false, bannedReason: '', bannedAt: null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const isAdmin = !!req.body.isAdmin;
    if (!isAdmin) {
      const snap = await db.collection('users').where('isAdmin','==',true).get();
      if (snap.size <= 1) return res.status(400).json({ error: '마지막 관리자의 권한은 제거할 수 없습니다.' });
    }
    await db.collection('users').doc(req.params.id).update({ isAdmin });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/admin/users/:id/credentials', auth, adminOnly, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username && !password) return res.status(400).json({ error: '변경할 내용을 입력하세요.' });
    const upd = {};
    if (username) {
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: '아이디는 영문·숫자·_만 3~30자로 입력하세요.' });
      const ex = await db.collection('users').where('username','==',username).limit(1).get();
      if (!ex.empty && ex.docs[0].id !== req.params.id) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
      upd.username = username;
    }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
      if (password.length > 128) return res.status(400).json({ error: '비밀번호는 128자 이하여야 합니다.' });
      upd.pw = await bcrypt.hash(password, 12);
    }
    await db.collection('users').doc(req.params.id).update(upd);
    res.json({ ok: true });
  } catch(e) { console.error('[credentials]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: '자기 자신은 삭제할 수 없습니다.' });
    const batch = db.batch();
    const [pSnap, eSnap, beSnap, rSnap] = await Promise.all([
      db.collection('posts').where('authorId','==',req.params.id).get(),
      db.collection('qf_exams').where('userId','==',req.params.id).get(),
      db.collection('be_exams').where('userId','==',req.params.id).get(),
      db.collection('reports').where('reporterId','==',req.params.id).get()
    ]);
    [pSnap, eSnap, beSnap, rSnap].forEach(s => s.docs.forEach(d => batch.delete(d.ref)));
    batch.delete(db.collection('users').doc(req.params.id));
    await batch.commit();
    res.json({ ok: true });
  } catch(e) { console.error('[admin del user]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/posts', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('posts').orderBy('createdAt','desc').get();
    const result = await Promise.all(snap.docs.map(async d => {
      const p = d.data();
      const uDoc = await db.collection('users').doc(p.authorId).get();
      const u = uDoc.exists ? uDoc.data() : {};
      return { id: d.id, title: p.title, published: p.published, createdAt: p.createdAt, username: u.username||'', displayName: u.displayName||'(탈퇴)' };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/series-stats', auth, adminOnly, async (req, res) => {
  try {
    const [uSnap, pSnap, eSnap, beSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('posts').get(),
      db.collection('qf_exams').get(),
      db.collection('be_exams').get()
    ]);
    const scopeMap = {};
    eSnap.docs.forEach(d => { const s = d.data().scope||'(미지정)'; scopeMap[s] = (scopeMap[s]||0)+1; });
    const scopes = Object.entries(scopeMap).sort((a,b)=>b[1]-a[1]).map(([scope,count])=>({scope,count}));
    res.json({ scopes, userCount: uSnap.size, postCount: pSnap.size, examCount: eSnap.size, beExamCount: beSnap.size });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const [uSnap, eSnap] = await Promise.all([db.collection('users').get(), db.collection('qf_exams').get()]);
    res.json({ userCount: uSnap.size, examCount: eSnap.size });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ EXAMS (qf_exams) ══ */

const MAX_EXAMS = 30;

app.get('/api/exams', auth, async (req, res) => {
  try {
    const snap = await db.collection('qf_exams').where('userId','==',req.user.id).get();
    res.json(snap.docs.map(d => { const e = d.data(); return { id: d.id, title: e.title, scope: e.scope, difficulty: e.difficulty, createdAt: e.createdAt }; }).sort((a,b)=>b.createdAt-a.createdAt));
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/exams/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('qf_exams').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '시험지를 찾을 수 없습니다.' });
    const e = doc.data();
    if (e.userId !== req.user.id) return res.status(403).json({ error: '권한이 없습니다.' });
    res.json({ id: doc.id, _id: doc.id, userId: e.userId, title: e.title, scope: e.scope, difficulty: e.difficulty, extra: e.extra, content: e.content, createdAt: e.createdAt });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/exams', auth, async (req, res) => {
  try {
    const snap = await db.collection('qf_exams').where('userId','==',req.user.id).get();
    if (snap.size >= MAX_EXAMS) return res.status(400).json({ error: `최대 ${MAX_EXAMS}개까지만 저장됩니다.` });
    const { title, scope, difficulty, content, extra } = req.body;
    if (!title || !content) return res.status(400).json({ error: '제목과 내용을 입력하세요.' });
    const id = uuid();
    await db.collection('qf_exams').doc(id).set({ userId: req.user.id, title: String(title).slice(0,120), scope: String(scope||'').slice(0,200), difficulty: String(difficulty||'기본').slice(0,50), extra: String(extra||'').slice(0,500), content: String(content).slice(0,200000), createdAt: Date.now() });
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/exams/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('qf_exams').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '시험지를 찾을 수 없습니다.' });
    if (doc.data().userId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: '권한이 없습니다.' });
    await db.collection('qf_exams').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/exams', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('qf_exams').orderBy('createdAt','desc').get();
    const result = await Promise.all(snap.docs.map(async d => {
      const e = d.data();
      const uDoc = await db.collection('users').doc(e.userId).get();
      const u = uDoc.exists ? uDoc.data() : {};
      return { id: d.id, title: e.title, scope: e.scope, difficulty: e.difficulty, createdAt: e.createdAt, username: u.username||'(탈퇴)', displayName: u.displayName||'(탈퇴)' };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/admin/exams/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('qf_exams').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ CONFIG ══ */
app.get('/api/config', (req, res) => {
  res.json({ bytenodeUrl: process.env.BYTENODE_URL || '' });
});

/* ══ 챗봇 FAQ ══ */
app.get('/api/chatbot/faqs', async (req, res) => {
  try {
    const snap = await db.collection('chatbot_faqs').orderBy('order').get();
    res.json({ faqs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chatbot/faqs', auth, adminOnly, async (req, res) => {
  try {
    const { question, answer, followUps } = req.body;
    if (!question || !answer) return res.status(400).json({ error: '질문과 답변을 입력하세요.' });
    const snap = await db.collection('chatbot_faqs').orderBy('order', 'desc').limit(1).get();
    const maxOrder = snap.empty ? 0 : (snap.docs[0].data().order || 0) + 1000;
    const ref = await db.collection('chatbot_faqs').add({
      question: question.trim(), answer: answer.trim(),
      followUps: Array.isArray(followUps) ? followUps : [],
      order: maxOrder, createdAt: Date.now()
    });
    res.json({ id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/chatbot/faqs/:id', auth, adminOnly, async (req, res) => {
  try {
    const { question, answer, followUps } = req.body;
    if (!question || !answer) return res.status(400).json({ error: '질문과 답변을 입력하세요.' });
    await db.collection('chatbot_faqs').doc(req.params.id).update({
      question: question.trim(), answer: answer.trim(),
      followUps: Array.isArray(followUps) ? followUps : []
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/chatbot/faqs/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('chatbot_faqs').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/chatbot/faqs/:id/move', auth, adminOnly, async (req, res) => {
  try {
    const { dir } = req.body; // 'up' | 'down'
    const snap = await db.collection('chatbot_faqs').orderBy('order').get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const idx = docs.findIndex(d => d.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '항목 없음' });
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= docs.length) return res.json({ ok: true });
    const batch = db.batch();
    batch.update(db.collection('chatbot_faqs').doc(docs[idx].id), { order: docs[swapIdx].order });
    batch.update(db.collection('chatbot_faqs').doc(docs[swapIdx].id), { order: docs[idx].order });
    await batch.commit();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ══ AI 챗봇 엔드포인트 ══ */
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const CHATBOT_SYSTEM_PROMPT = `당신은 bytenode와 byteexam 플랫폼 전용 AI 도우미입니다. 한국어로 친절하고 간결하게 답변하세요.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# bytenode 플랫폼 (현재 버전: 3)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bytenode는 선생님이 수업 자료(게시물)를 작성·공유하고 학생이 열람하는 교육 플랫폼입니다.

## 사용 방법
1. 상단 "새 글 쓰기" 버튼 클릭
2. 제목, 내용 및 요청사항, 태그, 커버 이미지(선택) 입력
3. 모드 선택 후 "AI 프롬프트 복사" → Claude/ChatGPT 등 AI에 붙여넣기
4. AI가 생성한 bytenode 코드를 에디터에 붙여넣기 → "발행" 클릭

## 3가지 모드 (3 버전 기준)

### 📝 bytenode 3 — 블로그 글쓰기
일반 글, 학습 자료, 설명 문서 등 텍스트 중심 게시물 작성.

DSL 태그 문법 (<tagname: 내용> 형태):
- <h1: 제목> / <h2: 소제목> / <h3: 소소제목> — 제목 계층
- <text: 내용> — 본문 단락 (마크다운 **굵게**, _기울임_, [링크](url) 지원)
- <img: URL | 설명 | 비율> — 이미지 삽입 (비율: wide/normal/small)
- <math: LaTeX식> — 수식 렌더링 (KaTeX)
- <table: 헤더1 | 헤더2 \n 값1 | 값2> — 표
- <code: 언어 | 코드> — 코드 블록
- <quote: 내용 | 출처> — 인용문
- <callout: 아이콘 | 제목 | 내용> — 강조 박스
- <footnote: 출처: 기관명·문서명·연도 또는 URL> — 통계·법령·연구 결과의 출처 각주
- <list: 항목1 | 항목2 | ...> — 목록
- <divider:> — 구분선
- <video: URL> — 동영상 임베드

### 📊 bytegraphic 2e — 인포그래픽 카드
통계, 데이터 시각화, 정보 카드 등 그래픽 중심 게시물.

DSL 태그:
- <stat: 수치 | 설명 | 색상> — 통계 수치 카드
- <piechart: 항목1=값1 | 항목2=값2 | 제목> — 파이 차트
- <barchart: 항목1=값1 | 항목2=값2 | 제목> — 막대 차트
- <infotile: 아이콘 | 제목 | 내용 | 색상> — 정보 타일
- <timeline: 연도|이벤트 \n 연도|이벤트> — 타임라인
- <compare: 항목A | 항목B \n 속성 | 값A | 값B> — 비교표

### 🎞️ bytenode-ppt 2e — 프레젠테이션
슬라이드 기반 발표 자료 작성.

DSL 태그:
- <slidecover: 제목 | 부제목 | 배경> — 표지 슬라이드
- <slide: 슬라이드 제목> — 본문 슬라이드
- <slidenote: 공간 계획> — 레이아웃 메모 (필수)
- <partition: 비율 | 간격> — 좌우 분할 레이아웃
- <freebox: x, y, w, h, 크기> — 자유 위치 박스
- <gradtext: 색1 | 색2 | 텍스트 | 크기> — 그라데이션 텍스트
- <stat: 수치 | 설명 | 색상> — 통계 강조
- <svg-asset: 너비, 높이> ... <endsvg> — SVG 직접 작성

## 공통 기능
- 커버 이미지: 이미지 파일 업로드 (URL 직접 입력 대신 파일 첨부)
- AI 프롬프트 복사 시 제목·요청사항 자동 포함
- 게시물 공개/비공개 설정
- 좋아요, 댓글, 스크랩 기능
- 관리자 페이지: 게시물·프롬프트·학생 현황 관리

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# byteexam 플랫폼 (현재 버전: 3s)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

byteexam은 AI를 이용해 수학·사회·정보·파이썬 시험지를 자동 생성하는 도구입니다.
주소: https://byteexam109.vercel.app

## 시험지 만들기 순서
1. "시험지 프롬프트 만들기" 버튼 클릭
2. 과목·범위·학년·교육과정·난이도·문항수 설정
3. "프롬프트 복사" → AI(Claude/ChatGPT)에 붙여넣기
4. AI 생성 결과 코드를 "코드 붙여넣기"에 입력
5. 미리보기 확인 → DOCX 내보내기 또는 PDF 인쇄

## 지원 과목 및 난이도
- 과목: 수학, 사회(중1~고3), 정보·파이썬(고1~고3), 독토글(독서·논술)
- 난이도: 기본 / 실력 / 강남8학군+전국단위자사고 / 모의고사변형 / 과학고+영재고
- 지역별 출제 맥락: 사회·수학에서 선택 가능, 정보·파이썬에서는 제공하지 않음

## byteexam DSL 코드 형식
---BYTEEXAM-START---
[HEADER] 과목·학년 정보
[TEXTBOOK] id=, title=, source=, content= 형식의 재사용 교과서형 지문
[QUESTION] num=번호 type=유형 points=배점 text=문제 answer=정답
[FIGURE:] / [COORD:] / [FIGURE3D:] 도형·그래프 태그 (2s 이상)
[PAGE] 페이지 구분
[ANSWER_SHEET] 정답 일람표
---BYTEEXAM-END---

## 3s 신기능 — 과목별 조사 프롬프트와 교과서형 지문
- 사회·정보·파이썬 과목과 난이도별 전용 문항 설계 기준
- 사회는 [TEXTBOOK] 블록의 여러 줄 지문을 textbook=textbook text 1 형식으로 문제에 연결
- 동일 지문을 여러 문항에서 재사용하고 PDF·DOCX·미리보기에 표시

## 도형 삽입 (📐 도형 삽입 버튼)
시험지 편집기 우측에 도형 삽입 버튼이 생겼습니다.
- [COORD:] 탭: 좌표계 (타원, 쌍곡선, 삼각함수, 지수, 로그, 적분 색칠 등)
- [FIGURE:] 탭: 기하도형 (삼각형, 사각형, 원, 호, 벡터 등)
- [FIGURE3D:] 탭: 3D 입체 (직육면체, 사각뿔, 원뿔, 구 등)
- 캔버스에서 클릭·드래그로 위치 조정 후 DSL 태그 자동 생성

## 저장 및 내보내기
- 최대 30개 시험지 저장 (초과 시 오래된 것 자동 삭제)
- DOCX(Word) 내보내기, 브라우저 PDF 인쇄 지원

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 계정
- 회원가입: bytenode 상단 "로그인" → "회원가입" 탭
- bytenode와 byteexam은 동일 계정 사용
- 비밀번호 변경: 프로필 → 계정 설정

# 주의사항
- 시험지는 AI가 생성하므로 반드시 검토 후 사용하세요
- 특정 문제집·출판사 저작권 자료는 포함되지 않습니다
- 수능·자격증 시험 유형은 준비중입니다 (2026년 추가 예정)

검색 결과가 제공된 경우 그 내용을 참고하여 답변하되, 출처를 명시하세요.
모르는 내용이나 플랫폼 외 사항은 솔직하게 "잘 모르겠다"고 하세요.`;

async function searchDuckDuckGo(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&kl=kr-kr`;
    const r = await fetch(url, { headers: { 'User-Agent': 'bytenode-chatbot/1.0' } });
    const data = await r.json();
    const results = [];
    if (data.AbstractText) results.push({ source: 'DuckDuckGo', text: data.AbstractText.slice(0, 400) });
    if (data.RelatedTopics?.length) {
      data.RelatedTopics.slice(0, 3).forEach(t => {
        if (t.Text) results.push({ source: 'DuckDuckGo 관련', text: t.Text.slice(0, 200) });
      });
    }
    return results;
  } catch { return []; }
}

async function searchWikipedia(query) {
  try {
    const url = `https://ko.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'bytenode-chatbot/1.0' } });
    if (!r.ok) return [];
    const data = await r.json();
    if (data.extract) return [{ source: '위키백과', text: data.extract.slice(0, 500) }];
    return [];
  } catch { return []; }
}

const needsWebSearch = msg => /검색|찾아|알려|뭐야|무엇|어떤|어디|언제|누구|왜|how|what|when|where|who|why/i.test(msg) && !/bytenode|byteexam|시험지|게시물|로그인|회원가입/.test(msg);

app.post('/api/chatbot/ai', async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(503).json({ error: 'AI 서비스가 설정되지 않았습니다.' });
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: '메시지가 없습니다.' });
  const trimmed = message.trim().slice(0, 1000);

  let searchContext = '';
  if (needsWebSearch(trimmed)) {
    const [ddg, wiki] = await Promise.all([searchDuckDuckGo(trimmed), searchWikipedia(trimmed)]);
    const all = [...ddg, ...wiki];
    if (all.length) {
      searchContext = '\n\n[검색 결과]\n' + all.map(r => `[${r.source}] ${r.text}`).join('\n\n');
    }
  }

  const messages = [
    { role: 'system', content: CHATBOT_SYSTEM_PROMPT + searchContext },
    ...(Array.isArray(history) ? history.slice(-10) : []),
    { role: 'user', content: trimmed }
  ];

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.BYTENODE_URL || 'http://localhost:4002',
        'X-Title': 'bytenode chatbot'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages,
        max_tokens: 800,
        temperature: 0.7
      })
    });
    if (!resp.ok) {
      const err = await resp.text();
      return res.status(502).json({ error: 'AI 응답 오류: ' + err.slice(0, 200) });
    }
    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content || '죄송합니다, 응답을 생성할 수 없었습니다.';
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ══ OAuth 클라이언트 (bytenode-account 개발자 콘솔용) ══ */
const nodeCrypto = require('crypto');
const sha256 = s => nodeCrypto.createHash('sha256').update(s).digest('hex');
/* 전체 redirect URI 허용 (경로·쿼리 포함 가능, http/https만) */
const validRedirectUri = v => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };

app.post('/api/oauth/clients', auth, async (req, res) => {
  try {
    const { name, origins, uris } = req.body || {};
    const nm = String(name || '').trim();
    if (!nm || nm.length > 40) return res.status(400).json({ error: '앱 이름은 1~40자여야 합니다.' });
    const raw = Array.isArray(uris) ? uris : (Array.isArray(origins) ? origins : []);
    const list = raw.map(o => String(o).trim().replace(/\/+$/, '')).filter(Boolean);
    if (!list.length || list.length > 10) return res.status(400).json({ error: 'redirect URI는 1~10개 등록해야 합니다.' });
    for (const o of list) if (!validRedirectUri(o)) return res.status(400).json({ error: `잘못된 redirect URI: ${o} (http/https 주소여야 합니다)` });
    const mine = await db.collection('oauthClients').where('ownerId', '==', req.user.id).get();
    if (mine.size >= 10) return res.status(400).json({ error: '앱은 계정당 최대 10개까지 등록할 수 있습니다.' });
    const clientId = 'bn_' + nodeCrypto.randomBytes(8).toString('hex');
    const secret = 'sk_' + nodeCrypto.randomBytes(24).toString('hex');
    await db.collection('oauthClients').doc(clientId).set({
      name: nm, redirectUris: list, ownerId: req.user.id, ownerName: req.user.username,
      secretHash: sha256(secret), createdAt: Date.now()
    });
    res.status(201).json({ clientId, clientSecret: secret, name: nm, redirectUris: list });
  } catch (e) { console.error('[oauth create]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/oauth/clients', auth, async (req, res) => {
  try {
    const snap = await db.collection('oauthClients').where('ownerId', '==', req.user.id).get();
    res.json(snap.docs.map(d => { const c = d.data(); return { clientId: d.id, name: c.name, redirectUris: c.redirectUris || c.origins || [], createdAt: c.createdAt }; }));
  } catch (e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/oauth/clients/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('oauthClients').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '앱을 찾을 수 없습니다.' });
    if (doc.data().ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: '권한이 없습니다.' });
    await db.collection('oauthClients').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* SSO 서버가 redirect_uri 검증에 사용 (공개 정보만) */
app.get('/api/oauth/clients/:id/public', async (req, res) => {
  try {
    const doc = await db.collection('oauthClients').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '등록되지 않은 client_id입니다.' });
    const c = doc.data();
    res.json({ clientId: doc.id, name: c.name, redirectUris: c.redirectUris || c.origins || [] });
  } catch (e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* 내부 전용 엔드포인트: SSO 서버만 호출 (공유 시크릿).
   미설정 시 통과(개발 편의)하되, 운영에서는 반드시 INTERNAL_SECRET 설정. */
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
function internalOnly(req, res, next) {
  if (!INTERNAL_SECRET) return next();
  if (req.headers['x-internal-secret'] === INTERNAL_SECRET) return next();
  return res.status(403).json({ error: 'forbidden' });
}

/* ── OAuth 인가 코드 grant 저장소 (opaque code, 1회성) ──
   SSO 서버가 로그인 완료 시 grant를 만들고, /token 교환 때 1회만 소비.
   access_token은 code에 담지 않고 여기 서버에만 저장됨. */
app.post('/api/oauth/grant', internalOnly, async (req, res) => {
  try {
    const { code, token, clientId, redirectUri, codeChallenge } = req.body || {};
    if (!code || !token || !clientId || !redirectUri) return res.status(400).json({ error: '필수 파라미터 누락' });
    /* 토큰이 실제 유효한지 확인 */
    let u; try { u = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: '유효하지 않은 토큰' }); }
    await db.collection('oauthCodes').doc(sha256(String(code))).set({
      token: String(token), clientId: String(clientId), redirectUri: String(redirectUri),
      codeChallenge: codeChallenge ? String(codeChallenge) : null,
      userId: u.id || '', used: false, expiresAt: Date.now() + 120000, createdAt: Date.now()
    });
    res.status(201).json({ ok: true });
  } catch (e) { console.error('[oauth grant]', e); res.status(500).json({ error: '서버 오류' }); }
});

/* 인가 코드 1회 소비 (트랜잭션으로 재사용 원천 차단) */
app.post('/api/oauth/grant/consume', internalOnly, async (req, res) => {
  try {
    const { code, clientId } = req.body || {};
    if (!code || !clientId) return res.status(400).json({ error: 'invalid_request' });
    const ref = db.collection('oauthCodes').doc(sha256(String(code)));
    const result = await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) return { err: 'invalid_grant' };
      const g = doc.data();
      if (g.used) return { err: 'invalid_grant' };            /* 이미 사용됨 → 거부 */
      if (g.clientId !== String(clientId)) return { err: 'invalid_grant' };
      if (Date.now() > g.expiresAt) { tx.delete(ref); return { err: 'invalid_grant' }; }
      tx.update(ref, { used: true, usedAt: Date.now() });
      return { g };
    });
    if (result.err) return res.status(400).json({ error: result.err });
    res.json({ token: result.g.token, redirectUri: result.g.redirectUri, codeChallenge: result.g.codeChallenge });
  } catch (e) { console.error('[oauth consume]', e); res.status(500).json({ error: 'server_error' }); }
});

/* SSO 서버가 토큰 교환 시 secret 검증에 사용 */
app.post('/api/oauth/verify', internalOnly, async (req, res) => {
  try {
    const { clientId, clientSecret } = req.body || {};
    if (!clientId || !clientSecret) return res.status(400).json({ ok: false });
    const doc = await db.collection('oauthClients').doc(String(clientId)).get();
    if (!doc.exists || doc.data().secretHash !== sha256(String(clientSecret))) return res.status(401).json({ ok: false });
    res.json({ ok: true, name: doc.data().name, origins: doc.data().origins });
  } catch (e) { res.status(500).json({ ok: false }); }
});

/* ══ 가입/로그인은 통합 계정 서버(bytenode-account)로 이관 ══ */
app.get('/welcome', (req, res) => {
  const q = req.query.redirect ? '?redirect=' + encodeURIComponent(req.query.redirect) : '';
  res.redirect(301, 'https://bytenode-account.vercel.app/welcome' + q);
});

/* ══ SPA fallback ══ */
/* 실제 헬스체크. 이전에는 이 경로가 catch-all로 넘어가 index.html이 200으로 나갔고,
   그래서 관리 대시보드가 서버 상태와 무관하게 항상 정상으로 표시했다. */
app.get('/api/health', async (req, res) => {
  let database = 'down';
  try { await db.collection('users').limit(1).get(); database = 'up'; } catch (_) {}
  res.set('Cache-Control', 'no-store').json({ ok: true, service: 'bytenode', database });
});

app.get('*', (req, res) => res.sendFile(path.join(PUB, 'index.html')));

app.listen(PORT, () => console.log(`\n✅ bytenode109 실행 중 → http://localhost:${PORT}\n`));
