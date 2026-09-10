export const ZOOM_STEPS = [0.5, 0.67, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
export const DEFAULT_SCALE = 1;

export const PALETTE = [
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be',
  '#1a73e8', '#5856d6', '#af52de', '#ff2d55', '#8e8e93',
  '#000000', '#ffffff',
];

export const HIGHLIGHTER_PALETTE = [
  '#ffeb3b', '#ffc107', '#ff9800', '#ff6bcb', '#7cf29c',
  '#7ce0ff', '#b39cff', '#ffffff',
];

export const WIDTH_PRESETS = {
  pen: [
    { key: 'thin', label: '얇게', value: 1.5 },
    { key: 'normal', label: '보통', value: 3.5 },
    { key: 'bold', label: '굵게', value: 7 },
  ],
  highlighter: [
    { key: 'thin', label: '얇게', value: 10 },
    { key: 'normal', label: '보통', value: 16 },
    { key: 'bold', label: '굵게', value: 26 },
  ],
  eraser: [
    { key: 'thin', label: '얇게', value: 10 },
    { key: 'normal', label: '보통', value: 20 },
    { key: 'bold', label: '굵게', value: 34 },
  ],
};

export const MAX_FAVORITES = 3;
export const HIGHLIGHTER_ALPHA = 0.55;

// "불편한 점 알리기" 팝업 전송을 디스코드 웹훅으로 보낸다.
// Formspree 무료 플랜 월 한도에 걸려 디스코드 웹훅으로 교체함 (2026-09-10).
export const FEEDBACK_FORM_ENDPOINT = 'https://discord.com/api/webhooks/1547408537737633804/HuXj5vh9gCUfVcYXvIUHOaU0mpsGOJsLvTMHpm16a4zmv0sY7n394zc0qf98Qt9FjoVt';

// 데스크톱 앱(src/main/main.js)과 동일한 목적 — 접속/종료 시각을 보호자가 확인할 수 있도록 자동 전송.
// Formspree 무료 플랜 월 한도에 걸려 디스코드 웹훅으로 교체함 (2026-09-10).
// 공개 저장소(pdf-notes-app-web)에 노출되는 값이라 데스크톱과는 별도 웹훅을 쓰는 게 이상적이지만,
// 현재는 같은 웹훅을 공유한다 — 악용되면 이 웹훅만 재발급하면 됨.
export const USAGE_LOG_ENDPOINT = 'https://discord.com/api/webhooks/1547391333650534450/arikFUgUPO_0XEWmFY-qr_veP7RpjJmUmFbXDIMzhD1Uo3t0y26EdWmAB6KYw3vH3AoY';

export const TEXT_FONT_FAMILY = '"Malgun Gothic", "Segoe UI", sans-serif';
export const TEXT_COLOR = '#000000';
export const TEXT_SIZE_MIN = 12;
export const TEXT_SIZE_MAX = 96;
export const TEXT_SIZE_STEP = 4;
export const TEXT_LINE_HEIGHT = 1.3;
