# Lecture Study Assistant

아이폰에서 녹음한 강의와 수업 자료를 iCloud Drive로 보내면 Windows PC가 받아서 과목별 Obsidian 노트로 정리해 주는 앱입니다. PC가 꺼져 있을 때 보낸 파일도 대기열에 남아 있다가 앱을 다시 실행하면 이어서 처리합니다.

현재 버전은 `0.1.0`이며 개발 중인 소스입니다. 서명된 설치 파일과 AI 설정 화면은 아직 준비되지 않았으므로, 실제 자료를 넣기 전 복사본으로 먼저 테스트해 주세요.

## 주요 기능

- 아이폰 단축어와 Scriptable을 이용한 강의 파일 전송
- Windows 파일 선택 및 드래그 앤 드롭
- 한 번에 최대 32개 파일을 하나의 과목으로 묶어서 등록
- 과목 추가·수정·보관·복원
- PC가 꺼져 있어도 유지되는 iCloud 대기열과 처리 상태 확인
- SHA-256 기반 중복 검사, 중단된 작업 복구, 충돌 파일 보존
- 과목별 강의노트, 개념 노트, 핵심정리, 문제은행, 마인드맵 생성 구조
- Codex CLI, Gemini API, OpenAI API, Claude API 연결 코드
- 기능별 AI 경로와 과목별 지침·프롬프트를 나눠 저장하는 구조
- 로컬 SQLite 상태 저장 및 Windows 보안 저장소를 이용한 API 키 보관

## 처리 흐름

```text
iPhone 단축어 / Windows 파일 선택
                ↓
        iCloud Drive 대기열
                ↓
       Windows 앱에서 파일 확인
                ↓
     분류 · 내용 추출 · AI 처리
                ↓
       Obsidian Vault에 정리
```

아이폰에서는 파일만 대기열에 넣습니다. 실제 처리와 Obsidian 파일 작성은 Windows PC에서 이루어집니다. 전송할 때 선택한 과목은 해당 파일 묶음 전체에 적용됩니다.

## 지원 파일

| 종류 | 확장자 |
|---|---|
| 음성 | `.m4a`, `.mp3`, `.wav`, `.aac`, `.flac` |
| 영상 | `.mp4` |
| 문서 | `.pdf`, `.pptx`, `.txt`, `.md` |
| 이미지 | `.png`, `.jpg`, `.jpeg`, `.heic` |

음성·영상 파일은 개별 4GB, 문서·이미지는 개별 500MB, 한 묶음은 최대 8GB까지 받을 수 있도록 제한되어 있습니다.

## 준비물

- Windows 11 64비트
- Node.js 24.19 계열
- npm 11 계열
- iCloud for Windows
- Obsidian
- iPhone 전송을 사용할 경우 Scriptable과 단축어 앱

## 소스에서 실행하기

```powershell
git clone https://github.com/pgrd1/Iphone-obsidian-ai-assistant.git
cd Iphone-obsidian-ai-assistant
npm ci
npm start
```

처음 실행하면 다음 세 가지만 설정하면 됩니다.

1. 결과를 저장할 Obsidian Vault를 선택합니다.
2. Windows의 iCloud Drive 안에 있는 `Scriptable` 폴더를 대기열로 선택합니다.
3. 과목명과 교수 표시명을 입력해 첫 과목을 만듭니다.

Vault를 iCloud Drive에 두면 같은 Apple 계정의 iPhone과 iPad에서도 노트를 볼 수 있습니다. 같은 Vault에 iCloud 동기화와 Obsidian Sync를 동시에 적용하지 마세요.

## 아이폰 단축어 연결

### 1. Scriptable 스크립트 넣기

1. 아이폰에 Scriptable을 설치하고 iCloud Drive 사용을 허용합니다.
2. Scriptable에서 `StudyAssistant`라는 새 스크립트를 만듭니다.
3. [`mobile/scriptable/StudyAssistant.js`](mobile/scriptable/StudyAssistant.js)의 내용을 전부 복사해 넣습니다.

설정이 끝나면 Scriptable을 직접 열 필요는 없습니다. 단축어가 백그라운드에서 이 스크립트를 실행합니다.

### 2. 강의 보내기 단축어 만들기

단축어 앱에서 아래 순서로 동작을 추가합니다.

1. `오디오 녹음` 또는 `파일 선택`
2. Scriptable의 `Run Script`
   - Script: `StudyAssistant`
   - Files: 앞 단계에서 만든 녹음 또는 선택한 파일
   - Shortcut Parameter: 비워 둠
3. Scriptable 출력에서 `message` 값 가져오기
4. `결과 보기` 또는 `알림 보기`

단축어를 실행하면 과목 목록과 `＋ 과목 추가`가 표시됩니다. 과목 추가를 선택하면 과목명과 교수 표시명을 입력한 뒤 같은 파일을 바로 보낼 수 있습니다.

### 3. 처리 상태 단축어 만들기

상태 확인용 단축어는 파일 없이 실행합니다.

1. `사전` 동작을 추가하고 `action` 값을 `status`로 설정
2. Scriptable의 `Run Script`에서 `StudyAssistant` 선택
3. 위 사전을 Shortcut Parameter로 전달
4. Scriptable 출력에서 `message` 값 가져오기
5. `결과 보기` 또는 `알림 보기`

PC가 꺼져 있어도 대기 중인 파일 수를 확인할 수 있습니다. PC와 iCloud 동기화가 다시 연결되면 앱이 새 작업을 가져옵니다.

## Obsidian 저장 구조

앱은 선택한 Vault의 `AI 학습` 폴더 안에서만 파일을 관리합니다.

```text
Vault/
└─ AI 학습/
   ├─ 학습 대시보드.md
   ├─ 학습 대시보드.base
   └─ 과목/
      └─ 과목명/
         ├─ 과목명.md
         ├─ 과목 색인.base
         ├─ 교수 강조·출제 프로필.md
         ├─ 핵심정리.md
         ├─ 강의노트/
         ├─ 개념/
         ├─ 원본자료/
         │  ├─ 녹음/
         │  ├─ 이미지/
         │  └─ 문서/
         ├─ 문제은행/
         │  ├─ 원문 문제.md
         │  ├─ AI 예상문제.md
         │  └─ AI 변형문제.md
         ├─ 마인드맵/
         │  ├─ 과목 전체.canvas
         │  └─ 과목 전체.svg
         ├─ 암기/
         │  └─ 암기 체크리스트.md
         ├─ 질문함/
         │  └─ AI 질문함.md
         └─ 시험/
            └─ PDF/
```

표준 Markdown과 Obsidian 링크를 사용하므로 별도의 커뮤니티 플러그인은 필요하지 않습니다. 사용자가 수정한 내용과 새로 생성한 내용이 충돌하면 기존 파일을 덮어쓰지 않고 충돌본을 따로 남깁니다.

## AI 연결 상태

AI 처리 코드는 들어 있지만 현재 앱 화면에서는 제공자, 모델, API 키, 기능별 프롬프트를 설정할 수 없습니다. 이 부분은 아직 코드 수준의 개발 기능이며 기본값으로 활성화되지 않습니다.

- 현재 런타임에 연결된 경로: Codex CLI, Gemini API, OpenAI API, Claude API
- Gemini CLI: 안전한 실행 조건을 더 확인하는 동안 기본 런타임에서 비활성화
- 각 API 키와 CLI 로그인은 서로 별개이며 사용자가 직접 준비해야 함
- 선택하지 않은 AI로 자동 전환하지 않음

AI 설정이 없는 상태에서 파일을 처리하면 작업이 `확인 필요`로 끝날 수 있습니다. 원본 파일은 삭제하지 않으며 설정 후 다시 시도할 수 있습니다.

## 아직 없는 기능

- 서명된 Windows 설치 파일과 자동 업데이트
- 앱 안에서 사용하는 AI 제공자·프롬프트 설정 화면
- 시험 대비 PDF 자동 생성
- HTML 퀴즈와 플래시카드 내보내기
- 바로 설치할 수 있는 공유용 iPhone 단축어 파일

`npm run make`로 만들 수 있는 설치 파일은 서명되지 않은 개발용 빌드입니다. Windows SmartScreen 경고가 나타날 수 있으며 공개 배포용으로 사용하면 안 됩니다.

## 개발 명령

```powershell
npm run lint
npm run typecheck
npm run test:coverage
npm run package:e2e
npm run test:e2e
npm audit --audit-level=high
npm run make
```

## 개인정보와 자료 사용

앱 계정이나 중앙 서버는 없고 진단 정보도 자동으로 업로드하지 않습니다. 다만 AI 기능을 연결하면 선택한 자료가 해당 제공자에게 전송될 수 있으므로 제공자의 데이터 처리 정책을 먼저 확인해야 합니다.

강의 녹음과 학교 자료는 수업 규정, 교수자 동의, 개인정보, 저작권을 확인한 뒤 사용하세요. 이 프로그램은 시험 점수를 보장하지 않습니다.

## 라이선스

[MIT License](LICENSE)로 배포합니다.
