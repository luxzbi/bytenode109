
let _cbFaqs = [], _cbOpen = false, _cbHistory = [], _cbAiLoading = false;

async function chatbotLoadFaqs() {
  try {
    const data = await fetch('/api/chatbot/faqs').then(r=>r.json());
    _cbFaqs = data.faqs || [];
  } catch(e) { _cbFaqs = []; }
}

function chatbotToggle() {
  _cbOpen = !_cbOpen;
  const win = document.getElementById('chatbotWindow');
  if (_cbOpen) {
    win.style.display = 'flex';
    _cbHistory = [];
    document.getElementById('chatbotMessages').innerHTML = '';
    chatbotBotMsg('안녕하세요! bytenode AI 도우미입니다. 아래 자주 묻는 질문을 선택하거나, 직접 질문을 입력하세요.');
    chatbotShowFaqs();
    setTimeout(() => document.getElementById('chatbotInput').focus(), 100);
  } else {
    win.style.display = 'none';
  }
  document.getElementById('chatbotToggle').textContent = _cbOpen ? '✕' : '💬';
}
function chatbotClose() { _cbOpen = false; document.getElementById('chatbotWindow').style.display='none'; document.getElementById('chatbotToggle').textContent='💬'; }

const CB_PAGE = 6;
function chatbotShowFaqs(offset) {
  offset = offset || 0;
  const btns = document.getElementById('chatbotBtns');
  if (offset === 0) btns.innerHTML = '';
  const slice = _cbFaqs.slice(offset, offset + CB_PAGE);
  slice.forEach(faq => {
    const btn = document.createElement('button');
    btn.textContent = faq.question;
    btn.style.cssText = 'text-align:left;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:#e2e8f0;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer;transition:background .15s;line-height:1.45;width:100%';
    btn.onmouseover = () => btn.style.background = 'rgba(255,255,255,.12)';
    btn.onmouseout = () => btn.style.background = 'rgba(255,255,255,.07)';
    btn.onclick = () => chatbotAsk(faq);
    btns.appendChild(btn);
  });
  if (offset + CB_PAGE < _cbFaqs.length) {
    const more = document.createElement('button');
    more.textContent = `더 보기 (${_cbFaqs.length - offset - CB_PAGE}개 남음)`;
    more.style.cssText = 'background:none;border:1px dashed rgba(255,255,255,.2);color:rgba(255,255,255,.45);border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;transition:color .15s;width:100%';
    more.onmouseover = () => { more.style.color='rgba(255,255,255,.75)'; more.style.borderColor='rgba(255,255,255,.4)'; };
    more.onmouseout = () => { more.style.color='rgba(255,255,255,.45)'; more.style.borderColor='rgba(255,255,255,.2)'; };
    more.onclick = () => { btns.removeChild(more); chatbotShowFaqs(offset + CB_PAGE); };
    btns.appendChild(more);
  }
}

function chatbotAsk(faq) {
  chatbotUserMsg(faq.question);
  _cbHistory.push({ role: 'user', content: faq.question });
  setTimeout(() => {
    chatbotBotMsg(faq.answer);
    _cbHistory.push({ role: 'assistant', content: faq.answer });
    const btns = document.getElementById('chatbotBtns');
    btns.innerHTML = '';
    if (faq.followUps?.length) {
      const label = document.createElement('div');
      label.textContent = '추가로 궁금한 점이 있으신가요?';
      label.style.cssText = 'font-size:12px;color:rgba(255,255,255,.45);padding:0 2px 4px';
      btns.appendChild(label);
      faq.followUps.forEach(fu => {
        const btn = document.createElement('button');
        btn.textContent = fu.question;
        btn.style.cssText = 'text-align:left;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:#e2e8f0;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer;transition:background .15s;line-height:1.45';
        btn.onmouseover = () => btn.style.background = 'rgba(255,255,255,.12)';
        btn.onmouseout = () => btn.style.background = 'rgba(255,255,255,.07)';
        btn.onclick = () => { chatbotUserMsg(fu.question); setTimeout(() => { chatbotBotMsg(fu.answer); chatbotShowResetBtn(); }, 220); };
        btns.appendChild(btn);
      });
    }
    chatbotShowResetBtn();
  }, 220);
}

function chatbotShowResetBtn() {
  const btns = document.getElementById('chatbotBtns');
  const existing = btns.querySelector('.cb-reset');
  if (existing) return;
  const btn = document.createElement('button');
  btn.className = 'cb-reset';
  btn.textContent = '🏠 처음으로';
  btn.style.cssText = 'background:none;border:1px solid rgba(255,255,255,.18);color:rgba(255,255,255,.5);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;margin-top:2px;transition:color .15s';
  btn.onmouseover = () => btn.style.color='rgba(255,255,255,.85)';
  btn.onmouseout = () => btn.style.color='rgba(255,255,255,.5)';
  btn.onclick = () => { document.getElementById('chatbotBtns').innerHTML = ''; chatbotShowFaqs(); };
  btns.appendChild(btn);
}

function chatbotUserMsg(text) {
  const msgs = document.getElementById('chatbotMessages');
  const div = document.createElement('div');
  div.style.cssText = 'align-self:flex-end;max-width:80%;background:rgba(59,130,246,.25);border:1px solid rgba(59,130,246,.4);color:#e2e8f0;border-radius:12px 12px 2px 12px;padding:9px 13px;font-size:13px;line-height:1.5;word-break:break-word';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}
function chatbotBotMsg(text) {
  const msgs = document.getElementById('chatbotMessages');
  const div = document.createElement('div');
  div.style.cssText = 'align-self:flex-start;max-width:88%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);color:#e2e8f0;border-radius:12px 12px 12px 2px;padding:9px 13px;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}
function chatbotLoadingMsg() {
  const msgs = document.getElementById('chatbotMessages');
  const div = document.createElement('div');
  div.id = 'cbLoading';
  div.style.cssText = 'align-self:flex-start;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.45);border-radius:12px 12px 12px 2px;padding:9px 13px;font-size:13px';
  div.textContent = '생각 중...';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

async function chatbotSendAI() {
  if (_cbAiLoading) return;
  const input = document.getElementById('chatbotInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  chatbotUserMsg(msg);
  document.getElementById('chatbotBtns').innerHTML = '';
  _cbHistory.push({ role: 'user', content: msg });
  _cbAiLoading = true;
  chatbotLoadingMsg();
  try {
    const r = await fetch('/api/chatbot/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: _cbHistory.slice(-10) })
    });
    const data = await r.json();
    const loading = document.getElementById('cbLoading');
    if (loading) loading.remove();
    const reply = data.reply || data.error || '오류가 발생했습니다.';
    chatbotBotMsg(reply);
    _cbHistory.push({ role: 'assistant', content: reply });
    chatbotShowResetBtn();
  } catch(e) {
    const loading = document.getElementById('cbLoading');
    if (loading) loading.remove();
    chatbotBotMsg('네트워크 오류가 발생했습니다.');
  } finally {
    _cbAiLoading = false;
  }
}

chatbotLoadFaqs();
