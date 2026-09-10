// Google Cloud Console에서 발급받은 값으로 교체하세요.
// - GOOGLE_CLIENT_ID: OAuth 2.0 클라이언트 ID (웹 애플리케이션)
// - GOOGLE_API_KEY: Picker API용 API 키
// - ALLOWED_EMAIL_HASHES: 이 앱에 로그인 가능한 구글 이메일 주소들을 SHA-256 해시한 값 목록
//   (학생 계정 + 보호자/개발자 계정 등 여러 개를 등록할 수 있다).
//   공개 저장소에 실제 이메일이 그대로 노출되지 않도록 평문 대신 해시로 저장한다.
//   새 이메일의 해시를 구하려면(터미널에서):
//   node -e "console.log(require('crypto').createHash('sha256').update('이메일주소'.trim().toLowerCase()).digest('hex'))"
export const GOOGLE_CLIENT_ID = '685257589496-23k7t285u2cl8s6pnn2eid6adi9acdu8.apps.googleusercontent.com';
export const GOOGLE_API_KEY = 'AIzaSyD8O2mDfHr2Y9Js4Fcg00lbUWEW3N0_gKs';
export const ALLOWED_EMAIL_HASHES = [
  '158ea936baade9d6bb3a3de159bfacfcc59d0c8cc2ee05a1f0458695e4972a59', // 학생 계정
  'bed48db1556db2f479d082605f891f411789fc3f4d492dc99ab6af2135d3c45a', // 개발자(gurwoghd@gmail.com) 계정
];

// drive.file 스코프로 Picker에서 고른 파일에 실제 접근 권한이 부여되려면 PickerBuilder.setAppId()에
// 구글 클라우드 프로젝트 번호가 필요하다 (OAuth 클라이언트 ID의 '-' 앞부분과 동일).
export const GOOGLE_APP_ID = GOOGLE_CLIENT_ID.split('-')[0];

// 학생 Drive 안에 필기 데이터/설정을 저장할 전용 폴더 이름 (내 드라이브에 그대로 보임).
export const APP_FOLDER_NAME = '저시력 학생 필기 프로그램';

// 앱이 만들거나 학생이 Picker로 직접 연 파일에만 접근하는 최소 권한 범위.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
