# Dùng tầng ký ức

Code nói **cái gì đang chạy**. Nó không nói **vì sao**. Một hàm thử lại hai lần
thì đọc là hiểu; còn chuyện lần thử thứ ba từng tồn tại và bị bỏ vì cổng thanh
toán đếm nó thành một lượt authorise mới thì không nằm trong code, và sẽ không
bao giờ nằm ở đó.

Đó là thứ hệ này lưu, và mọi thứ bên dưới đều suy ra từ đó.

---

## Toàn bộ luồng, một lần

```
cài plugin
        │
        ▼
dai-memory init ──────────────────────────────────────────┐
        │  tạo .memory/                              │
        │  dò xem nền này làm được gì                │  một lệnh
        │  quét toàn bộ cây repo                     │
        │  dựng code graph (file → khai báo)         │
        │  ghi .memory/ui.html                       │
        ▼                                             ┘
mở .memory/ui.html      ← đồ thị, kho ký ức, báo cáo sức khoẻ
        │
        ▼
làm việc ── plugin tự đọc, không cần bạn nhớ gì:
        │   đầu phiên           → ràng buộc + xung đột chưa xử
        │   trước Read/Grep     → memory biết gì về file đó
        │   trước git commit    → diff đang stage chạm vào gì
        ▼
dai-memory write ────────────── ghi một quyết định, bằng tay, kèm lý do
        │
        ▼
dai-memory ingest ───────────── sau khi file đổi (nên đặt vào post-commit)
        │  không tham số: quét toàn bộ cây repo
        │  thu hồi file không còn trên đĩa
        │  thay thế những gì file đó từng sinh ra
        │  ghi lại ui.html
        ▼
dai-memory prune ────────────── thỉnh thoảng: dọn ghi chép episodic cũ, không ai trỏ tới
```

Hai thứ tự động, hai thứ không, và sự phân chia đó là có chủ đích.

**Đọc là tự động.** Hook nạp ngữ cảnh lúc mở phiên, trước khi đọc file, và trước
khi commit. Không phải nhớ gì.

**Đánh chỉ mục là dữ liệu dẫn xuất**, nên cho nó tự chạy là an toàn — file mới là
sự thật, chạy lại là idempotent, và cái duy nhất hỏng được là để nó lạc hậu. Đặt
`dai-memory ingest` vào `post-commit`.

**Ghi một quyết định là phán đoán**, nên nó nằm trong tay bạn. Lý do chọn phương
án này thay vì phương án kia là phần không máy nào suy ra được, và đó cũng là
phần duy nhất đáng lưu.

**Quên cũng là phán đoán.** `dai-memory prune` chỉ xoá ghi chép episodic cũ mà không
ai trỏ tới, và không bao giờ động vào một quyết định dù nó cũ đến đâu.

---

## Cài đặt, một lần cho mỗi dự án

```bash
dai-memory init
```

Một lệnh. Nó tạo kho, dò xem nền này làm được gì, quét dự án, dựng code graph, và
ghi ra trang xem.

Nó quét **toàn bộ cây repo**, không đoán thư mục nào quan trọng. Trước đây nó
chỉ nhận tên quy ước (`docs/`, `src/`...) cộng các thư mục trông giống một dự án,
và đo trên một repo C# thật thì cách đó **bỏ sạch** thư mục `openspec/` với 408
file markdown, cùng `wiki/` và `human-only/`, chỉ vì tên của chúng không nằm trong
danh sách nào. Cây thư mục càng được tổ chức kỹ thì đoán càng sai.

Đoán thư mục vốn chỉ để tránh vơ code vendor và output build vào kho. Giờ lần
quét tự loại những thứ đó **theo luật**, ở mọi độ sâu: thư mục thư viện và build,
bí mật, lockfile, file nhị phân, `.memignore`, và mục nào bị bỏ cũng được báo kèm
lý do. Có đủ những luật đó rồi thì gốc repo là mục tiêu đúng.

Thư mục bắt đầu bằng dấu chấm thì bị bỏ, trừ những thư mục chứa **cấu hình của
dự án**: `.github`, `.gitlab`, `.husky`, `.circleci`, `.devcontainer`, và
`.claude`, nơi team để agent, command và skill (ví dụ quy ước kiến trúc
`arch-module`). `.vscode` và `.idea` vẫn bị bỏ vì đó là editor của một người, và
`.claude/settings.local.json` cũng bị bỏ vì là cài đặt cá nhân. Auto memory của
Claude nằm ở thư mục home, ngoài repo, nên lần quét không bao giờ chạm tới.

```bash
dai-memory init docs src/billing   # quét đúng những đường dẫn này
dai-memory init --no-scan          # chỉ tạo kho, quét sau
```

Phần đáng đọc nhất là báo cáo năng lực — đây là chỗ duy nhất cho bạn biết tìm
kiếm ngữ nghĩa đang chạy thật hay đang chạy bản dự phòng:

```
graph              ok      ladybugdb
fts                ok      persisted-bm25
vectorSearch       ok      exact-scan
embeddings         ok      local
tokenizer          ok      unicode-fold-v3
astChunking        ok      web-tree-sitter -- 36 languages
```

Model được tải bởi `node bin/setup.mjs` — đo thật: **130 MB** cho
`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, vào `<MEMORY_LAYER_HOME>/models`.
Setup, `init` và `embed` được phép tải nó; không lệnh nào khác tải, và không lệnh
nào chạy khi thiếu nó: search, write và ingest từ chối kèm thông báo chỉ đích danh
script setup. Máy nào đã chạy setup một lần thì sau đó chạy offline được.

### Chạy lại `init`

Trên dự án đã có kho, `init` **dựng lại** chứ không tạo mới. Mọi thứ lần quét
sinh ra được — các chunk, code graph, chỉ mục từ khoá — bị xoá và đọc lại từ
đầu, nên một luật vừa thêm vào `.memignore` có hiệu lực luôn với những gì đã
index trước đó. Mọi thứ do người ghi thì **giữ nguyên**: quyết định, sự cố, ràng
buộc, quy trình, tóm tắt, liên kết giữa chúng, liên kết từ chúng tới các chunk,
và anchor của chúng lên khai báo trong code. Các memory được giữ lại sẽ được
embed lại theo không gian của model hiện tại.

Liên kết nào mà đầu kia không quay lại được — nội dung chunk đã đổi, khai báo đã
đổi tên — thì không khôi phục được, và được **liệt kê theo id** chứ không bị bỏ
ngầm; `init --json` liệt kê đủ.

```bash
dai-memory init              # dựng lại phần quét được, giữ phần người ghi
dai-memory init --no-scan    # cập nhật kho, không dựng lại gì
dai-memory init --fresh      # xoá hẳn kho, kể cả memory người ghi
```

`--fresh` là cách duy nhất làm mất memory người ghi qua `init`, và phải gõ rõ ra.
Nó từ chối, không đổi gì, khi có tiến trình khác đang mở kho — một phiên Claude
Code đang nạp plugin là như vậy — và từ chối kho nằm chung thư mục với registry
và cache model.

Rồi mở trang nó vừa ghi:

```
.memory/ui.html
```

---

## Giữ cho nó không lạc hậu

```bash
dai-memory ingest
```

Chạy lại rẻ: hash nội dung khiến file không đổi bị bỏ qua, lượt thứ hai trên 47
file gần như không tốn gì. Mỗi lần chạy cũng ghi lại trang xem, nên trang và kho
không bao giờ nói khác nhau.

"Không đổi" nghĩa là cùng nội dung **và** cùng phiên bản bộ đọc code. Sau khi nâng
cấp mà cách đọc code thay đổi, lần `ingest` kế tiếp tự đọc lại mọi file do bản cũ
đọc, và dòng `code reader` của `doctor` cho biết còn bao nhiêu file đang chờ. Nếu
chỉ so nội dung, một repo đã index từ trước khi ngôn ngữ của nó có code graph sẽ
giữ đồ thị rỗng mãi mãi, vì file nào cũng "không đổi".

**Sửa một file sẽ thay thế những gì nó từng sinh ra.** Id của chunk suy từ nội
dung, nên file đổi là id đổi — và cho tới khi việc này được xử lý, một file sửa
bốn lần thành **bốn node**, tất cả đều nằm trong index, tất cả cùng trả lời một
câu hỏi. Giờ bản cũ bị xoá, hoặc bị cho về hưu nếu có thứ gì trỏ tới nó: một
quyết định mà nguồn gốc dẫn tới hư vô còn tệ hơn một mảnh cũ. Báo cáo nói rõ:

```
ingested 3 files (0 unchanged) -> 12 new, 0 refreshed, 12 embedded, 4 removed, 1 superseded
```

**Cho `ingest` tự chạy.** Chỉ mục là dữ liệu dẫn xuất: file mới là sự thật, chạy
lại là idempotent, và không có phán đoán nào trong đó. Cái duy nhất hỏng được là
để nó lạc hậu, mà chỉ mục lạc hậu thì trả lời về code tuần trước **mà không nói
gì**.

```bash
printf 'dai-memory ingest --quiet || true\n' >> .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

Đặt ở `post-commit`, không phải mỗi lần lưu file: nội dung đã chốt, không có gì
khác đang giữ khoá ghi, và đó đúng là lúc file thay đổi một cách đáng ghi nhận.
Chữ `|| true` quan trọng — tầng ký ức **không bao giờ được phép** chặn commit
của bạn.

**Ghi ký ức bằng tay.** Ghi một quyết định là phán đoán, và lý do là phần không
máy nào suy ra được:

```bash
dai-memory write --layer semantic \
  --title "Thử lại hai lần, không dùng exponential backoff" \
  --body "Cổng thanh toán đếm mỗi lần thử là một lượt authorise mới, nên backoff
          sẽ giữ tiền của khách hai lần." \
  --source-ref "docs/adr-001.md#L12-L20"
```

`--source-ref` là bắt buộc. Một ký ức không truy ngược được là ký ức không kiểm
chứng được, mà người ta vẫn sẽ tin nó.

---

## Cái gì được nạp

Bất cứ thứ gì là văn bản, đuôi nào cũng được và to nhỏ gì cũng được. Không có
danh sách ngôn ngữ được hỗ trợ, vì một danh sách như vậy luôn sai một chút:
danh mục của chính GitHub có khoảng một nghìn đuôi file, và bất kỳ tập con nào
tự giữ bằng tay cũng sẽ bỏ sót đúng cái ngôn ngữ dự án bạn đang dùng. Đo trên
một repo thật, danh sách cũ bỏ sót **một phần năm** số file — phần lớn là script
shell — và không nói một lời nào.

Nên câu hỏi được lật ngược. Vài danh sách ngắn nói cái gì **không** bị quét vào,
và cái nào cũng tự báo cáo:

| Không nạp | Vì sao | Muốn nạp thì làm sao |
|---|---|---|
| `.png` `.pdf` `.docx` `.zip` … | Không phải văn bản, chẳng có gì để index | Để AI đọc phân tích rồi ghi lại kết luận |
| `.env` `.pem` lockfile `*.min.js` | Bí mật và sổ sách của máy | Cố ý. Một credential không được phép chạm tới embedding |
| `.svg` `.drawio` `.puml` `.mermaid` | Bản xuất từ công cụ thiết kế / vẽ sơ đồ | `dai-memory ingest docs/figma/tokens.svg` |
| `.csv` `.tsv` `.rtf` | Tài liệu và dữ liệu bảng | `dai-memory ingest docs/q1.csv` |
| `node_modules` `dist` `build` `.git` … | Sinh tự động hoặc của bên thứ ba | `dai-memory ingest docs/build` |

Markdown **không bao giờ** nằm trong mấy hàng đó. Nó chính là định dạng mà người
ta chuyển mọi thứ sang để đọc được, nên nó luôn được quét vào.

`.html`, `.xml`, `.ini`, `.cfg`, `.conf`, `.properties` cũng vậy. Một template,
một layout Android, một file config Spring là **một phần của cách hệ thống chạy**,
không phải tài liệu nói về nó — chúng là mã nguồn và được nạp như mã nguồn.

Word, Excel, PDF là **nhị phân**, nên có chỉ định đích danh cũng chẳng có gì để
index. `dai-memory ingest report.pdf` trước đây báo `1 new, 1 embedded` rồi nhét
byte thô vào kho dưới dạng vector; giờ nó **từ chối** và chỉ sang `dai-memory write`.
Gọi đích danh thắng được **chính sách**, không thắng được **vật lý**.

Hai hàng giữa mới là phần cần hiểu. Một bản xuất thiết kế hay một file PDF thường
không đáng lưu nguyên: thứ đáng giữ là **kết luận** ai đó rút ra từ nó, ghi bằng
`dai-memory write` kèm `--source-ref` trỏ ngược về file. Vài nghìn mảnh toạ độ đường
vẽ không phải là kết luận. Nhưng đôi khi chính file đó là tài liệu tham chiếu, và
**gọi đích danh thì luôn thắng** — thắng luật này, thắng danh sách chặn thư mục,
và thắng cả ngưỡng dung lượng.

Mọi lần bỏ qua đều được in ra kèm lý do và kèm đường thoát:

```
ingested 12 files (0 unchanged) -> 12 new, 0 refreshed, 12 embedded
skipped 4:
   2 not text (.pdf .png)
      nothing to index; read it with an agent and record the conclusion
   1 not indexed unless named (.svg)
      name the file to index it anyway
   1 excluded directory (build)
      name the directory to index it anyway
   --verbose to list them
```

Bỏ qua là một quyết định hợp lý. Bỏ qua **trong im lặng** mới là cách một kho
ký ức trở nên vừa được tin vừa thiếu sót.

### Dung lượng

Mã nguồn và văn bản **không bao giờ** bị từ chối vì lớn. Một module lớn là một
phần lớn của dự án, và một tầng âm thầm từ chối index những file lớn nhất thì tệ
hơn một tầng chạy hơi lâu.

Chi phí là thật, và nó tính bằng **số chunk chứ không phải số byte** — hai thứ
này lệch nhau rất xa. Đo được: 3 MB văn bản thành 3 444 chunk, còn 300 KB mã
nguồn dày đặc khai báo thành **7 494** chunk, vì chunker cắt theo biên khai báo.
File nào đẻ ra số chunk bất thường sẽ được **nêu tên** trong báo cáo chứ không bị
từ chối — vì từ đây nhìn vào, một API client sinh tự động và một module lõi viết
tay trông y hệt nhau, chỉ bạn mới biết cái nào là cái nào.

### Code được đọc thế nào

Cả 36 grammar đi kèm package đều được dùng; package có thêm grammar mà bảng rule
không có là một test fail.

| Nhóm | Ngôn ngữ | Ghi lại gì |
|---|---|---|
| Khai báo, ở mọi độ sâu | TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C#, Kotlin, Scala, Swift, Dart, PHP, Ruby, C, C++, Objective-C, Lua, Bash, Elixir, OCaml, Zig, Solidity, ReScript, Emacs Lisp, SystemRDL, TLA+, Elm, CodeQL | Class, method, hàm, kiểu và biến cấp module, mỗi cái mang tên kèm thứ bao nó: `OrderService.Get`, chứ không phải hai cái `Get`. Biến cục bộ trong thân hàm không được ghi |
| Parse lại | Vue | Khối `<script>` bằng grammar TypeScript hoặc JavaScript theo `lang`, `<style>` bằng CSS |
| Chỉ cấu trúc | CSS, HTML, JSON, TOML, YAML, ERB/EJS | Không có symbol — không có gì trong đó khai báo code — nhưng chunk được cắt theo rule, element, key và table |

Một khai báo quá lớn cho một chunk được cắt **giữa các thành phần của nó**: class
giữa các method, object JSON giữa các key, file CI giữa các job. Chỉ một dòng đơn
không còn cấu trúc để chia, như file minified, mới rơi về cắt theo ký tự. Ngôn ngữ
không có grammar vẫn được index, dưới dạng văn bản.

Bốn grammar — Elm, CodeQL, YAML và Lua — được nạp từ `packages/core/grammars/`
thay vì `tree-sitter-wasms`, vì bản build của gói đó không nạp được, hoặc (với Lua)
chỉ parse đúng một lần mỗi process. Nguồn gốc và checksum từng file ghi trong
README của thư mục đó.

### Đoạn code này tác động tới đoạn nào

Ngoài chuyện file khai báo gì, đồ thị còn ghi ba quan hệ: **gọi hàm**, **kế thừa**
và **import**. Đây là thứ biến một danh sách khai báo thành một tấm bản đồ, và là
thứ cho phép hook trước lúc commit trả lời "còn chỗ nào chạm tới cái này".

Phần khó là phân giải cái tên, và ở đây làm được mà không cần type checker. Một
lời gọi ghi `FindAsync`; nó là khai báo nào thì xét theo bốn luật, lần lượt, và
**kết quả mang theo luật nào đã tìm ra nó**:

| Mức chắc chắn | Nghĩa là |
|---|---|
| `file` | khai báo duy nhất mang tên đó trong chính file đang gọi |
| `receiver` | phần đứng trước chấm chính là chủ sở hữu: `OrderMapper.ToDto` |
| `import` | khớp duy nhất trong số các file mà file này import |
| `unique` | khai báo duy nhất mang tên đó trong cả repo |

Với C# và Java còn một luật nữa gánh phần lớn công việc: `using`/`import` trỏ tới
một namespace trải trên nhiều file, nên khai báo nào nằm trong namespace mà file
này nhìn thấy được thì tính là tới được qua import.

**Nếu không luật nào chọn ra đúng một khai báo thì không ghi gì cả.** Hai class
cùng có method `Save`, không có import nào tách bạch, không suy được kiểu của
receiver: lời gọi đó bị tính là **mơ hồ** và được báo ra. Một vùng ảnh hưởng dựng
trên phỏng đoán còn tệ hơn một vùng ảnh hưởng thừa nhận chỗ mình không biết.

Còn lời gọi vào framework — `HasColumnName`, `ToList`, `Produces` — thì trỏ tới
thứ repo này không hề khai báo. Loại đó được đếm riêng là **đi ra ngoài repo**, vì
nó không phải lỗ hổng và sẽ không bao giờ nối được: đo trên một service C# thật,
chúng chiếm đa số các điểm gọi, và gộp chung vào làm một đồ thị đang chạy tốt
trông như mới hoàn thành 5%. `doctor` báo tỉ lệ trên **các lời gọi vào chính repo
này**.

Lời gọi đọc được ở **mọi ngôn ngữ có khai báo — cả 29**. Grammar của Dart không có
node lời gọi, chỉ có chuỗi selector, nên luật của nó đọc ngược tên hàm từ danh sách
tham số; SystemRDL thì không có khái niệm gọi hàm, nên việc khởi tạo component được
đọc như một lời gọi khởi tạo.

**Đồ thị này dùng để làm gì.** Có hai chỗ đi theo nó, mỗi lần một bước:

- **Hỏi về một khai báo** thì trả về cả ký ức ghi cho những khai báo mà nó gọi và
  những khai báo gọi nó. Lý do một hàm trả về null thay vì ném lỗi thường được ghi
  ở chỗ có người dựa vào điều đó — tức là ở phía gọi. Ký ức tới được qua cạnh gọi
  xếp sau mọi kết quả trực tiếp, vì "ghi cho chính nó" và "ghi cho thứ nó gọi" là
  hai khẳng định khác nhau.
- **Bước kiểm trước commit** báo cả quyết định ghi ở **nơi gọi vào** những file bạn
  vừa sửa, kèm tên khai báo mà nó chạm tới. Trước đây sửa hàm bị gọi thì không thấy
  gì, dù ràng buộc ở phía gọi đã được ghi rõ.

## Bốn thứ bạn thực sự sẽ chạy

### `dai-memory why <file|symbol>`

Dự án đã quyết gì về đoạn code này. Đường dẫn thì neo theo nguồn gốc, tên trần
thì neo theo khai báo:

```bash
dai-memory why src/charge.js
dai-memory why chargeInvoice
```

Đọc dòng `fusion` ở cuối. `degraded: semantic` nghĩa là nhánh đó không tìm ra gì,
hoặc bị bỏ qua — câu trả lời đến từ ít nguồn hơn vẻ ngoài của nó.

### `dai-memory changes`

Trước khi commit. Đây là lúc ký ức đáng giá nhất: không phải lúc khám phá, mà
đúng ngay trước khi một thay đổi hạ cánh và mâu thuẫn với thứ ai đó đã quyết và
đã ghi lại.

```bash
dai-memory changes                          # đang stage
dai-memory changes --scope compare --base main
```

Nó cũng liệt kê những file **không** có gì được ghi nhận. Đó là cố ý: "memory
không tìm thấy gì" và "chưa ai hỏi memory" mà chỉ hiện phần tìm thấy thì nhìn
giống hệt nhau.

### `dai-memory map`

Code graph — file nào khai báo gì, và ký ức nào nói về từng cái.

```bash
dai-memory map                        # dạng cây, để đọc
dai-memory map src/store              # thu hẹp theo đường dẫn
dai-memory map --format mermaid       # sơ đồ, để nhìn
```

Bản Mermaid render được ở bất cứ đâu markdown chạy. Dán vào README, vào issue,
hay bất kỳ trình xem nào:

```mermaid
graph LR
  F0["src/charge.js"]
  F0 --> F0S0("chargeInvoice")
  F0S0 -.->|about| F0S0M0["Retry policy"]
```

### `dai-memory ui`

Một file HTML, dữ liệu nhúng sẵn. Không server, không bước build — mở thẳng từ ổ
đĩa.

```bash
dai-memory ui                     # ghi .memory/ui.html
dai-memory ui src/store           # thu hẹp theo đường dẫn
dai-memory ui --out graph.html    # chỗ nào tiện gửi cho người khác
dai-memory ui --max-nodes 6000    # vẽ nhiều hơn mức mặc định 3000
```

**Nó sinh ra lúc nào:** `dai-memory init` ghi nó, và mọi lần `ingest` hay `prune` có
thay đổi gì đều ghi lại. Bạn hiếm khi phải gõ `dai-memory ui` — lệnh đó để xem một
phần thu hẹp, hoặc để lấy một bản gửi cho ai đó.

**Reload trình duyệt có cập nhật không? Không, và không thể.** Dữ liệu được nhúng
cứng vào file. Trình duyệt **từ chối `fetch` qua `file://`**, nên trang mở từ ổ
đĩa không đọc được file dữ liệu nằm cạnh nó; nhúng inline là cách duy nhất để
trang chạy mà không cần server, và điều đó biến nó thành một **ảnh chụp**. Bấm
refresh chỉ ra đúng ảnh chụp cũ — thứ làm mới nó là lần `ingest` kế tiếp. Phần
đầu trang có ghi thời điểm dựng, để bạn biết thứ mình đang nhìn cũ tới đâu.

`--no-ui` bỏ qua bước ghi lại cho lệnh nào không muốn trả cái giá đó, khoảng
600 ms trên kho 638 node.

Ba tab: bản đồ 3D của code — file, khai báo trong đó, lời gọi giữa chúng, cái gì
kế thừa cái gì, file nào import file nào, và ký ức ghi cho bất kỳ thứ nào trong số
đó; kho ký ức dạng bảng lọc được; và báo cáo `doctor`. Cạnh gọi hàm và kế thừa có
mũi tên, rê chuột lên sẽ thấy nó được phân giải bằng luật nào.

Khai báo treo vào khai báo bao nó: file giữ `OrderService`, và `OrderService`
giữ `Get`.

Click **bất kỳ node nào** cũng mở ra thứ nó nói về — một khai báo trả lời bằng ký
ức ghi nhận cho nó và cho mọi thứ nó bao, một file trả lời bằng mọi ký ức của các
khai báo trong đó cộng thêm những gì ghi thẳng vào đường dẫn. Click không ra gì thì **nói ra** chứ
không im lặng.

Nền sáng mặc định. Nút ở đầu trang đổi sang tối và nhớ lựa chọn; nó **không** đi
theo hệ điều hành, vì làm vậy sẽ trả trang tối cho người vốn muốn trang trắng.

**Trang chỉ đọc, và là ảnh chụp.** Mọi lệnh ghi trong hệ này là tiến trình ngắn
hạn — đó là thứ cho phép nhiều phiên chạy cùng lúc mà không tranh kho; một trang
giữ kết nối ghi sẽ phá đúng tính chất đó. Chỗ nào cần thay đổi, trang đưa bạn câu
lệnh.

Phần 3D tải thư viện từ CDN, nên lần mở đầu tiên cần mạng. Nếu không tải được,
trang **nói rõ hỏng ở đâu** thay vì hiện canvas trắng — đồ thị trắng đọc thành
"trong này không có gì", một thông điệp khác hẳn và tệ hơn nhiều. Hai tab kia dữ
liệu nằm inline nên chạy bình thường.

Trên 3000 node, đồ thị bị cắt, và thứ tự **được giữ chỗ** là: ký ức do người ghi,
rồi file cùng các khai báo cấp trên cùng, rồi **các member mà lời gọi thật sự chạy
qua** (cái nhiều cạnh nhất trước), rồi các member còn lại, cuối cùng là chunk. Trước
khi sửa, ngân sách bị file và class ăn hết: trên repo 630 file, chỉ 46 trong 4.188
lời gọi có đủ hai đầu được vẽ — bản đồ của một hệ thống chủ yếu nằm ở method, vì đó
là nơi có lời gọi. Phần bị cắt được **báo trên tab Health** kèm số lượng từng
loại, và mọi ký ức vẫn nằm đủ trong tab Memories. Chunk bị cắt trước vì trên một
repo thật có hàng nghìn chunk: khi ký ức được giữ trước, 7 567 chunk chiếm hết
1 500 chỗ và đồ thị không hiện nổi một file. Thu hẹp bằng đường dẫn, hoặc nâng giới
hạn bằng `--max-nodes 4000` nếu máy vẽ nổi.

### `dai-memory doctor`

Cái gì đang thực sự chạy. Chạy khi kết quả có vẻ sai, và chạy trong CI:

| Dòng | Nghĩa là gì khi nó kêu |
|---|---|
| `embedding model FAIL` | Model chưa có trên đĩa — `node bin/setup.mjs`. Mọi thứ cần embed đều không chạy cho tới khi có |
| `interrupted writes WARN` | Một lệnh bị ngắt giữa lúc ghi và write-ahead log của nó không phát lại được. Kho đã được phục hồi về lần checkpoint gần nhất, log được giữ bên cạnh; chạy lại lệnh đó rồi xoá bản `store.lbug.wal.unreplayable-*` |
| `tokenizer version FAIL` | Postings cũ hơn bản build này — `dai-memory ingest --force` |
| `model drift WARN` | Vector đã lưu thuộc model khác — `dai-memory embed --force` |
| `keyword index WARN` | Một số node vô hình với tìm kiếm từ khoá |
| `index WARN` | Chỉ mục lùi sau HEAD — `dai-memory ingest` |
| `journal WARN` | Lệnh ghi đang xếp hàng sau khoá — `dai-memory merge` |

Một dòng `FAIL` nên làm đỏ build của bạn. Mỗi dòng ở đây đều mô tả một kiểu tìm
kiếm **sai âm thầm**, không phải hỏng ồn ào.

---

## Quên

```bash
dai-memory prune --dry-run            # xem trước cái gì sẽ đi
dai-memory prune                      # episodic, cũ hơn 90 ngày, không ai trỏ tới
dai-memory prune --older-than 30
```

Ba điều kiện, bắt buộc cả ba, không cái nào lỡ tay tắt được:

- **Chỉ episodic.** Một quyết định không thành rác vì nó cũ.
- **Cũ hơn ngưỡng.**
- **Không ai trỏ tới.** Ký ức có thứ trỏ tới nó là một mắt xích trong lập luận
  của ai đó, xoá đi là cắt đứt mắt xích ấy trong im lặng. `prune` từ chối.

Xoá là xoá node, postings của nó, dòng độ dài, và phần của nó trong các số liệu
trung bình. Chỉ làm việc đầu tiên sẽ để lại một chỉ mục từ khoá trả về id không
resolve được — không lỗi nào, chỉ là trả lời sai.

---

## Ghi tự động, và vì sao nó đang tắt

```bash
export MEMORY_LAYER_AUTO_RECORD=1
```

Bật lên thì một lệnh shell thất bại sẽ thành ký ức `episodic` — nguyên liệu cho
cạnh `RESOLVES` khi bạn ghi lại cách sửa.

**Cân nhắc xem bạn có muốn không.** Nó ghi **mọi** lần thất bại, mà phần lớn thất
bại là gõ nhầm. Một phiên có test chập chờn sinh ra vài chục cái. Giờ đã có
`prune` nên đây là một lựa chọn chứ không còn là cái bẫy, nhưng nói thẳng thì:
bật khi bạn đã có thói quen prune, đừng bật trước. Giá trị của tầng ký ức nằm ở
chỗ **thứ trong đó đáng tin**.

---

## Cái gì tự chạy

Cài dưới dạng plugin, bốn hook chạy mà không cần bạn làm gì. Ba trong số đó chỉ
đọc:

| Khi nào | Làm gì |
|---|---|
| Đầu phiên | Nạp ràng buộc đang hiệu lực và xung đột chưa xử |
| Trước `Read`/`Grep`/`Glob` | Bơm những gì memory biết về file đó |
| Trước `git commit` | Chạy `changes` trên diff đang stage |
| Sau khi `Bash` thất bại | Ghi lại — **chỉ khi** có `AUTO_RECORD=1` |

Hook trước-tool dùng `--anchor-only`, tức bỏ qua việc nạp model nhúng. Đó là
khác biệt giữa 3,3 giây và 0,6 giây trên **mỗi** file agent đụng vào.

---

### Hook tiêu bao nhiêu

Trước đây giới hạn là **số mục** — ba. Ba mục có thể là 60 token hoặc 6 000
token tuỳ người ta viết dài hay ngắn, nên cùng một con số mà chi phí lệch trăm
lần — và nó **không bao giờ nói đã bỏ lại gì**. Chín ký ức về một file, hiển thị
ba, sáu cái kia biến mất không dấu vết — ngay trong đường chạy nhiều nhất, tức
là trên mọi Read, Grep và Glob.

Giờ cả hai hook tiêu theo **ngân sách token** và báo cáo phần còn lại:

```
Project memory has 9 entries about src/charge.js, showing 3:
- [semantic] Chốt ở hai lần, không backoff (docs/adr-001.md#L12-L20)
- [decision] ...
- [episodic] ...
6 more not shown: dai_memory_why src/charge.js
```

| Biến | Mặc định | Áp cho |
|---|---|---|
| `MEMORY_LAYER_HOOK_TOKENS` | 400 | Trước Read, Grep, Glob |
| `MEMORY_LAYER_SESSION_TOKENS` | 700 | Ràng buộc lúc mở phiên |

Hai tính chất quan trọng hơn con số. **Mục đầu tiên luôn được giữ** dù dài đến
đâu — vì một ngân sách có thể trả về rỗng sẽ biến một ký ức quá khổ thành câu
"file này không có ghi chép nào", tức là ngược hẳn sự thật. Và **file không có
gì ghi thì hook vẫn im hoàn toàn**, nên chi phí luôn tỉ lệ với mức hữu ích.

`dai-memory search` và `dai-memory why` giờ trả thêm `total` và `omitted` trong `--json`
vì cùng lý do đó. `dai-memory changes` đã báo số bỏ sót từ ngày nó được viết; đúng
hai lệnh mà hook gọi thì lại không.

### GraphRAG, giờ mới thật sự truy xuất

`search.ts` **không duyệt một cạnh nào**. Mọi liên kết ghi giữa các quyết định —
SUPERSEDES, CONTRADICTS, DERIVED_FROM — chỉ ảnh hưởng tới `dai-memory conflicts` và
`dai-memory graph`, không ảnh hưởng gì tới kết quả tìm kiếm. Gọi thứ đó là GraphRAG
là hứa một điều không xảy ra.

Fusion giờ có **nhánh thứ tư**. Nó đi **một bước** từ những gì ba nhánh kia tìm
được, **theo cả hai chiều**, và xếp hạng hàng xóm theo **số kết quả độc lập cùng
trỏ tới nó**:

```
search "quebecpayment"
   bm25/semantic tìm:   "Retry twice on quebecpayment"
   graph đi một bước:   "Ledger holds sierrafunds twice"   <- không trùng chữ nào
```

Ba lựa chọn đáng biết. **Một bước**, vì một quyết định cách ba liên kết thì liên
quan theo kiểu mọi thứ trong một đồ thị nhỏ đều liên quan với nhau, và fusion sẽ
xếp cái nhiễu đó ngang hàng với kết quả trúng thật. **Cả hai chiều**, để
`A SUPERSEDES B` nổi A lên khi B trúng — biết thứ mình vừa khớp đã bị thay thế
chính là lúc câu trả lời lạc hậu gây hại nhất. Và **hàng xóm mà nhánh khác đã
tìm ra thì bị loại**, vì fusion thưởng cho sự đồng thuận giữa các nhánh, một
nhánh vọng lại chính đầu vào của mình sẽ thổi phồng đúng những kết quả không cần
giúp.

Trên một kho chưa ai nối gì thì nó **không đóng góp gì** — đó là trạng thái bình
thường, không phải lỗi — nên nó **nói ra**, thay vì trả về danh sách rỗng đọc y
hệt một nhánh chạy rồi không khớp:

```
graphWalk  ok  one-hop-neighbours
fusion: bm25=3 semantic=3 recency=3 graph=0
        graph: Nothing the other branches found is linked to anything.
               Record links with `dai-memory link`.
```

`graph` trong báo cáo sức khoẻ là **engine cơ sở dữ liệu**; `graphWalk` là
**nhánh truy xuất** này. Hai thứ khác nhau, và gọi chung một tên sẽ giấu lỗi của
cái này sau dòng xanh của cái kia.

### Nối dây cho đồ thị

Nhánh graph truy xuất **theo cạnh**, mà cho tới giờ **không có gì tạo ra cạnh**.
`ABOUT` chỉ do ingest ghi, nên một quyết định viết tay — loại ký ức giá trị nhất —
**không có đường nào** đi tới hàm mà nó nói về: đồ thị giữ symbol, kho giữ quyết
định, hai thứ nằm cùng một file mà không nối. Cạnh giữa các ký ức còn tệ hơn, vì
nó cần ai đó **nhớ gõ** `dai-memory link` đúng lúc — mà một tính năng chỉ chạy khi
người dùng nhớ ra là nó tồn tại thì phần lớn thời gian là không chạy.

**Thứ suy ra được thì suy ra.** Một `source_ref` có khoảng dòng đã tự nói nó phủ
lên khai báo nào:

```bash
dai-memory write --layer semantic   --title "Chốt ở hai lần, không backoff"   --body "Cổng thanh toán đếm mỗi lần thử là một lượt authorise mới."   --source-ref "src/charge.js#L1-L3"

# anchored to chargeInvoice
```

`dai-memory why chargeInvoice` giờ trả về quyết định đó, dù quyết định **không hề
nhắc tên hàm**. Khoảng dòng không phủ khai báo nào thì không neo gì, và cũng
không kêu ca — cả hai đều là chuyện bình thường.

**Thứ là phán đoán thì vẫn là phán đoán**, và được đưa ra dưới dạng **lệnh chạy
được**, không phải lời khuyên:

```
related memories -- link them if they bear on each other:
  dai-memory link mem_7f2 mem_3a9 DERIVED_FROM   # Chốt ở hai lần trên cổng thanh toán
```

**Gợi ý, không bao giờ tự tạo.** Nhánh graph truy xuất **xuyên qua** cạnh, nên
một cạnh đoán sai không nằm im vô hại: nó kéo một quyết định chẳng liên quan vào
kết quả suốt đời kho, và không thứ gì phía sau phân biệt được cạnh đoán với cạnh
có cân nhắc. `dai-memory conflicts` cũng in lệnh `CONTRADICTS` theo cách đó — trước
đây nó phát hiện mâu thuẫn rồi để việc ghi lại cho người dùng tự lo, nên cùng một
cặp bị phát hiện lại từ đầu mỗi lần có người hỏi.

### Chọn trước, đọc sau

Một kết quả đầy đủ mang theo 220 ký tự trích đoạn, tốn chừng sáu mươi token.
`dai-memory index` trả về **cùng thứ hạng** nhưng chỉ có tiêu đề, lớp và source_ref —
khoảng **mười lăm** token — nên ngân sách trước đây hiện được sáu mục thì giờ phủ
hơn hai mươi:

```bash
dai-memory index "retry"            # danh sách tiêu đề để chọn
dai-memory search "retry"           # đọc kỹ những cái đáng, có trích đoạn
dai-memory get <id>                 # một cái, đầy đủ
```

Cả hai đều nhận `--offset`. `3 more of 9 not shown -- --offset 6` giờ là thứ bạn
**làm được gì đó**, chứ không còn là một lời xin lỗi.

### .memignore

Câu trả lời của chính dự án về thứ nên nằm ngoài kho. Cú pháp gitignore, đặt ở
gốc repo:

```
# sinh lại được, và không ai quyết định gì trong đó
exports/
scratch.md
src/generated/
*.bak
!keep.bak
```

Các danh sách dựng sẵn là phỏng đoán về repo nói chung, mà phỏng đoán về repo nói
chung thì sai với từng repo cụ thể. File này **không bao giờ thắng** một đường dẫn
được gọi đích danh — `dai-memory ingest docs/exports` vẫn đọc thư mục đó dù luật nói
gì, vì một chỉ thị đưa ra **bây giờ** đứng trên một luật viết **từ trước**.

## Nhiều dự án

```bash
memory register     # thêm dự án này vào registry chung
dai-memory list         # mọi dự án, kèm độ tươi của chỉ mục
dai-memory forget       # bỏ khỏi registry (kho vẫn còn)
```

Tìm kiếm **không** đi xuyên dự án. Đó là mặc định và là cố ý: ký ức từ repo của
một khách hàng xuất hiện trong repo khác là một sự cố, không phải tính năng.

---

## Biến môi trường

| Biến | Tác dụng |
|---|---|
| `MEMORY_LAYER_HOME` | Registry và cache model (mặc định `~/.memory-layer`) |
| `MEMORY_LAYER_MODEL_CACHE` | Trọng số model, nếu bạn cần để chỗ khác |
| `MEMORY_LAYER_EMBED_DEVICE` | Thiết bị chạy model (mặc định `cpu`) |
| `MEMORY_LAYER_AUTO_RECORD=1` | Tự ghi lệnh thất bại |
| `MEMORY_LAYER_OUTPUT_BUDGET` | Trần byte cho output tool MCP (mặc định 24000) |
| `MEMORY_LAYER_HOOK_TOKENS` | Ngân sách token trước Read/Grep/Glob (mặc định 400) |
| `MEMORY_LAYER_SESSION_TOKENS` | Ngân sách token cho ràng buộc đầu phiên (mặc định 700) |
| `MEMORY_LAYER_MAX_FILE_MB` | Chặn file phình bất thường (mặc định 20) |

Trên Windows, giữ đường dẫn cache model **ngắn**. Mặc định nó nằm sâu dưới pnpm,
và đường dẫn quá 260 ký tự sẽ hỏng với thông báo `File doesn't exist` — đọc y hệt
như mạng bị chặn, mà không phải vậy.

---

## Khi kết quả có vẻ sai

1. **`dai-memory doctor`.** Phần lớn nằm ở một trong các dòng của bảng trên.
2. **Đọc dòng `fusion`.** `degraded` gọi tên mọi nhánh không đóng góp gì. Ba
   nhánh rỗng và một kết quả yếu thì không phải câu trả lời chắc chắn.
3. **Kiểm `source_ref`.** Nếu nó trỏ vào dòng đã dịch chuyển thì chỉ mục lạc hậu
   — chạy `dai-memory ingest`.
4. **Thử hỏi không dấu.** Tiếng Việt được đánh chỉ mục cả hai dạng, nên
   `quyet dinh` tìm ra `quyết định`. Nếu câu có dấu chạy mà câu không dấu không
   chạy, postings đang thuộc tokenizer đời cũ.

Ký ức mô tả điều đã đúng **vào lúc nó được ghi**. Nó là ngữ cảnh, không bao giờ
là hiện trạng — thứ gì bạn sắp hành động dựa trên nó thì kiểm lại với cây mã
nguồn trước.
