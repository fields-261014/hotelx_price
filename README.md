# HoteLux 요금 알림

GitHub의 무료 자동 실행(GitHub Actions)으로 하루 두 번 HoteLux 요금을 조회하고, 가격이 내려가면 텔레그램으로 알려줍니다. 내 컴퓨터를 켜둘 필요가 없어요.

- 대상: 파크 하얏트 부산, 그랜드 하얏트 서울, JW 메리어트 서울(강남), 시그니엘 부산
- 범위: 오늘부터 120일, 날짜별 1박·성인 2명
- 요금제: Hyatt Prive, Virtuoso, HoteLux Exclusive Rate만 (Vita 제외)
- 알림: 날짜·객실별 역대 최저 대비 8% 이상 하락, 또는 목표가 이하 첫 도달
- 시간: 09:00·15:20 조회 시작 → 약 10:00·16:20 알림 (GitHub 사정으로 10~30분 늦어질 수 있어요)
- 현황: 저장소의 `report.md` 에서 월별 최저가와 날짜별 요금을 볼 수 있어요.

## 설치 (처음 한 번, 약 15분)

### 1. GitHub 가입
https://github.com/signup 에서 가입합니다.

### 2. 저장소 만들기
1. 오른쪽 위 **+** → **New repository**
2. 이름: 아무거나 (예: `hotel-price`)
3. **Public** 선택 → **Create repository**

> Public이어야 자동 실행 시간이 무제한 무료예요. Private은 월 2,000분 한도라 이 작업(월 약 3,600분)에는 부족해요. 저장소에는 호텔 요금 데이터만 있고 개인정보나 텔레그램 정보는 들어가지 않아요.

### 3. 파일 올리기
1. 새 저장소 화면에서 **uploading an existing file** 링크를 누릅니다.
2. 압축을 푼 폴더 안의 내용(`scan.mjs`, `config.json`, `README.md`, `.github` 폴더)을 전부 끌어다 놓습니다.
3. **Commit changes** 를 누릅니다.

> `.github` 폴더가 안 보이거나 업로드되지 않으면: **Add file → Create new file** 에서 이름 칸에 `.github/workflows/scan.yml` 을 입력하고, 같은 이름 파일의 내용을 복사해 붙여넣은 뒤 **Commit changes**.

### 4. 텔레그램 봇 만들기
1. 텔레그램 앱에서 **@BotFather** 를 검색해 대화를 엽니다.
2. `/newbot` 을 보내고, 안내에 따라 봇 이름과 아이디(끝이 `bot`)를 정합니다.
3. BotFather가 주는 **토큰**(예: `123456789:ABC...`)을 복사해 둡니다.
4. 방금 만든 내 봇을 검색해 대화창에서 아무 메시지(예: `안녕`)를 보냅니다.
5. 브라우저 주소창에 `https://api.telegram.org/bot<토큰>/getUpdates` 를 입력합니다. (`<토큰>` 자리에 3번 토큰)
6. 결과에서 `"chat":{"id":123456789` 의 숫자가 **채팅 ID** 예요.

### 5. 토큰과 채팅 ID 등록
1. 저장소의 **Settings → Secrets and variables → Actions**
2. **New repository secret** 으로 두 개를 추가합니다.
   - Name `TELEGRAM_TOKEN`, Secret: 4-3의 토큰
   - Name `TELEGRAM_CHAT_ID`, Secret: 4-6의 숫자

### 6. 첫 실행
1. 저장소의 **Actions** 탭 → 안내가 뜨면 워크플로 사용을 허용합니다.
2. 왼쪽 **HoteLux 요금 조회** → 오른쪽 **Run workflow** → **Run workflow**
3. 약 40~60분 뒤 텔레그램으로 "첫 조회 완료" 메시지와 호텔별 4개월 최저가가 옵니다.

첫 조회는 기준값을 쌓는 단계라 하락 알림은 다음 회차부터 나옵니다.

## 자주 바꿀 것

**목표가 설정**: `config.json` 을 열고 연필 아이콘으로 편집 → 호텔의 `"targetKrw": null` 을 `"targetKrw": 400000` 처럼 바꾸고 **Commit changes**.

**하락 기준 변경**: `config.json` 의 `"dropPct": 8` 을 원하는 숫자로.

**잠시 멈추기**: Actions 탭 → HoteLux 요금 조회 → 오른쪽 `···` → **Disable workflow**.

## 문제가 생기면

- "이번 조회가 대부분 실패했어요" 메시지가 오면 HoteLux가 GitHub 서버의 접속을 막은 것일 수 있어요. 이 경우 이 방식은 쓸 수 없고, 기존 기록은 그대로 남아요.
- Actions 탭에서 실행 기록을 누르면 진행 로그를 볼 수 있어요.
