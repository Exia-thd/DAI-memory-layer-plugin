# Memory layer plugin

Ký ức dự án cho Claude: nó ghi lại **vì sao** — quyết định, sự cố đã dẫn tới
quyết định đó, ràng buộc, và quan hệ giữa chúng — rồi lấy ra khi agent cần lý do
đằng sau đoạn code mà nó không viết.

Nó ghi nhận **mỗi file khai báo những gì**, và các khai báo đó tác động lên nhau
ra sao — gọi hàm, kế thừa, import, trên 29 ngôn ngữ — để một câu hỏi về symbol
vừa có chỗ neo vừa có đường đi tiếp. Đồ thị không phải là mục đích; tới được lý
do mới là. *Cái gì gọi cái gì* chính là cách một quyết định ghi trên một hàm được
tìm thấy từ đoạn code phụ thuộc vào nó.

> Bản tiếng Anh: [README.md](README.md) · Hướng dẫn dùng:
> [docs/usage_vn.md](docs/usage_vn.md)

---

## Nó làm gì

```
$ dai-memory why src/billing/retry.ts

 1. [semantic] Chốt retry thẻ bị từ chối ở hai lần
    docs/billing.md#L3-L8
    Chọn thay vì exponential backoff vì cổng thanh toán đếm số lần thử, không
    đếm thời gian trôi qua. Hai lần thì vẫn dưới ngưỡng heuristic chống gian lận.

 2. [episodic] Tài khoản merchant bị gắn cờ
    session:2026-09-01
    Ba lần thử trên một thẻ bị từ chối đã kích heuristic chống gian lận; tài
    khoản bị gắn cờ sáu tiếng.

fusion: bm25=3 semantic=2 recency=4 anchor=2
```

Mục thứ hai là sự cố. Mục thứ nhất là quyết định `RESOLVES` nó. Hỏi từ đầu nào
cũng ra đầu kia.

---

## Cài

Cần Node 20.11+ và một git repository.

### Dưới dạng plugin của Claude Code

```
/plugin marketplace add Exia-thd/DAI-memory-layer-plugin
/plugin install dai-memory
```

Rồi chạy một lần, trong thư mục plugin vừa cài:

```bash
node bin/setup.mjs
```

Cài plugin chỉ là **chép repo về** — nó không cài dependency, không biên dịch
TypeScript, không tải model embedding, mà plugin này cần cả ba. `setup.mjs` làm
cả ba và kiểm tra từng thứ đã thật sự có. Chừng nào chưa xong, plugin từ chối
chạy và lúc mở phiên nó nói rõ vì sao, thay vì im lặng: một plugin trông như đã
cài mà không làm gì cả mới là hỏng nặng hơn.

Cài xong khởi động lại Claude Code để MCP server chạy. `.mcp.json` đăng ký
server và `hooks/` nối nó vào phiên; không cần cấu hình tay gì thêm.

### Từ bản clone

```bash
node bin/setup.mjs                      # thư viện, build và model -- đủ cả ba

node bin/dai-memory.mjs init            # kho, quét, code graph, trang xem
node bin/dai-memory.mjs search "vì sao thử lại thẻ bị từ chối"
```

`init` là toàn bộ phần cài đặt: nó quét những chỗ quy ước mà dự án hay để tài
liệu và mã nguồn, dựng code graph, rồi ghi `.memory/ui.html` — mở file đó bằng
trình duyệt là thấy nó tìm được gì.

**Cài xong nghĩa là đủ cả ba: thư viện, build, và model embedding.**
`setup.mjs` làm theo đúng thứ tự đó và dừng kèm lý do ở bước đầu tiên bị hỏng;
chạy lại thì làm tiếp từ chỗ đã dừng. Không có lối tắt nào bỏ qua model —
chỉ `pnpm install && pnpm build` thôi thì plugin sẽ từ chối chạy.

Chừng nào chưa đủ cả ba:

- MCP server không khởi động, và nói rõ thiếu gì;
- lúc mở phiên cũng báo như vậy, ở mọi dự án;
- `search`, `why`, `write`, `ingest` và `merge` từ chối, chỉ đích danh
  `setup.mjs` — chúng không bao giờ tự tải model, và không bao giờ chạy khi thiếu;
- `doctor` vẫn chạy, và báo FAIL ở dòng `embedding model`.

**Đã cài rồi?** Chạy lại `setup.mjs` sẽ bỏ qua phần đã xong — không cài lại,
không build lại, không tải lại; trên máy đã cài nó chạy vài giây. **Sau khi cập
nhật plugin**, chạy lại nó: mỗi bản build ghi lại nó được build từ đâu (mã nguồn,
manifest, lockfile), và một bản build của code cũ sẽ từ chối chạy và báo đã lỗi
thời, chứ không âm thầm chạy phiên bản trước. Setup cũng thấy điều đó và build lại.

Không có đường lùi. Từng có — đặc trưng băm từ vựng, lúc đầu tự động rồi sau
thành tuỳ chọn — và cái kho dựng bằng nó vẫn trả lời mọi câu hỏi, chỉ là tệ hơn,
không phân biệt được với đang chạy tốt, cho tới lúc cả lịch sử dự án đã nằm
trong một không gian vector không so sánh được với không gian của model. Bộ băm
từ vựng giờ chỉ còn cho test suite.

Cài vào một codebase **đã tồn tại** chính là trường hợp hệ này sinh ra để phục
vụ, nên không có chỗ nào giả định repo trống.

Hướng dẫn theo từng việc, kể cả nên tự động hoá cái gì và không nên cái gì, nằm
ở [docs/usage_vn.md](docs/usage_vn.md).

---

## Lệnh

| Lệnh | Làm gì |
|---|---|
| `dai-memory init [paths...] [--fresh]` | Tạo kho, quét dự án, dựng code graph và trang xem. Chạy lại thì dựng lại phần quét được và giữ phần người ghi; `--fresh` xoá cả phần người ghi |
| `dai-memory index <query>` | Chỉ tiêu đề, ~15 token mỗi mục — chọn trước khi đọc |
| `dai-memory ingest [paths]` | Nạp file — không tham số thì tự quét dự án. Thay thế bản cũ, thu hồi thứ đã biến mất, ghi lại trang xem |
| `dai-memory search <query>` | Truy hồi ba nhánh, kèm báo cáo hợp nhất |
| `dai-memory why <file\|symbol>` | Quyết định và ràng buộc chạm tới nó |
| `dai-memory changes [--scope S]` | Ký ức nói gì về những file bạn sắp commit |
| `dai-memory get <id>` | Một node đầy đủ, kèm cạnh của nó |
| `dai-memory graph <id> --depth N` | Duyệt đồ thị ký ức |
| `dai-memory constraints` | Những gì dự án đã chốt |
| `dai-memory conflicts` | Mâu thuẫn cần người quyết |
| `dai-memory map [path] [--format mermaid]` | Code graph: file, khai báo, cái gì gọi cái gì, và ký ức về từng cái |
| `dai-memory clusters` | Cụm trong đồ thị ký ức, kèm tóm tắt nếu có |
| `dai-memory summarize <id> --body S` | Ghi tóm tắt cho một cụm, nối vào các thành viên |
| `dai-memory session start\|end` | Mở/đóng phiên, để lệnh ghi biết nó xảy ra lúc nào |
| `dai-memory write` / `dai-memory link` | Ghi một ký ức, hoặc nối hai ký ức |
| `dai-memory merge` | Gộp các lệnh ghi đang xếp hàng vào kho |
| `dai-memory list` | Các dự án đã đăng ký, kèm độ tươi của chỉ mục |
| `dai-memory ui [path] [--out FILE]` | Dựng trang xem: đồ thị 3D, kho, sức khoẻ |
| `dai-memory prune [--older-than N] [--dry-run]` | Quên ghi chép episodic cũ, không ai trỏ tới |
| `dai-memory doctor` | Cái gì đang thực sự chạy |
| `dai-memory serve` | MCP server trên stdio |

---

## Truy hồi hoạt động thế nào

Ba nhánh, hợp nhất bằng reciprocal rank fusion ở `k=60`, khoá theo **node id**
chứ không theo đường dẫn file — một file có thể chứa nhiều quyết định mâu thuẫn
nhau, gộp về file là trộn chúng làm một.

```
query ├─► BM25 (dòng postings trong kho)        ─┐
      ├─► semantic (cosine xếp hạng trong DB)   ─┼─► RRF k=60 ─► mở rộng đồ thị
      └─► recency × importance                  ─┘
```

Mỗi nhánh thu hẹp về danh sách ứng viên **trước khi** nạp bất cứ thứ gì: kết quả
từ khoá đến từ một dòng cho mỗi term, độ tương đồng xếp hạng ngay trong database
bằng `array_cosine_similarity`, và chỉ những node sống sót sau hợp nhất mới được
đọc đầy đủ. Không chỗ nào trên đường này đọc cả kho, nên chi phí tỉ lệ với **câu
hỏi**, không tỉ lệ với lượng đã nhớ.

Mọi kết quả đều mang khối `fusion`:

```jsonc
{
  "results": [ /* ... */ ],
  "fusion": {
    "branches": { "bm25": 12, "semantic": 0, "recency": 20 },
    "degraded": ["semantic"],
    "reasons": { "semantic": "Chưa node nào trong kho có vector." },
    "k": 60
  }
}
```

**Đây là quyết định thiết kế quan trọng nhất của cả dự án.** Một nhánh trả về
rỗng mà không nói gì sẽ biến hợp nhất thành "nhánh nào còn chạy", và không ai
biết. Báo cáo phân biệt *đã chạy và không khớp gì* với *không chạy được*, và nêu
lý do. Đó là thứ agent cần để biết bảng xếp hạng này đáng tin tới đâu.

---

## Ràng buộc thiết kế

Mỗi ràng buộc canh một lỗi **đã quan sát được thật**, và mỗi cái có test riêng.

| # | Ràng buộc |
|---|---|
| C1 | Một kho duy nhất. Không có bước migrate giữa ghi và đọc. |
| C2 | Một hiện thực cho mỗi khả năng. |
| C3 | Không nuốt lỗi. Mọi lệnh thoát khác 0 kèm lý do. |
| C4 | Hợp nhất phải khai báo nhánh rỗng của nó. |
| C5 | Truy vấn khớp theo term, không bao giờ theo chuỗi con. |
| C6 | Không có tham số trang trí. `depth` phải thật sự đổi cách duyệt. |
| C7 | Thứ gì ghi được thì phải đọc lại được qua một đường có test đi qua. |
| C8 | Mọi import đều là phụ thuộc đã khai báo. |
| C9 | Không tự nhận một khả năng chưa cài. |
| C10 | Reader không bao giờ phục vụ ảnh chụp cũ hơn lần ghi gần nhất. |
| C11 | Bộ đếm ghi chỉ tăng **sau** khi commit bền, không bao giờ trước. |

C10 và C11 đến từ **đo đạc**, không đến từ kế hoạch. Một handle LadybugDB chỉ đọc
bị đóng băng ở thời điểm mở và **không báo lỗi** khi nó lạc hậu; và vì bộ đếm sửa
chuyện đó nằm ngoài database, thứ tự giữa commit và tăng bộ đếm tự nó là một hợp
đồng. Làm ngược thứ tự sẽ khiến chốt chặn khẳng định một điều sai — tệ hơn là
không có chốt nào. Xem [docs/m0-findings.md](docs/m0-findings.md).

### Luật đứng sau tất cả

Ba lỗi tệ nhất trong lịch sử dự án này có **cùng một hình dạng**: một thành phần
biến mất, một `try/catch` hoặc một `?? []` hấp thụ nó, và hệ thống chạy tiếp với
chất lượng thấp hơn mà **không phát ra tín hiệu nào**. RRF âm thầm tụt hạng khi
một nhánh trả rỗng; nhánh từ khoá thành `undefined` rồi bị vá thành mảng rỗng;
một AST chunker chưa từng chạy lần nào.

Nên:

> **Bất kỳ thành phần nào có thể vắng mặt mà hệ vẫn chạy được đều phải có một
> dòng trong `capabilities`. Không có ngoại lệ cho "cái này chắc chắn luôn có".**

AST chunker chính là thứ mọi người đều chắc chắn là luôn có.

```bash
node --test --test-concurrency=1 tests/*.test.js   # 119 test
node packages/cli/dist/cli.js doctor
```

---

## Mô hình dữ liệu

Bốn lớp — `semantic` (quyết định, ràng buộc), `episodic` (chuyện đã xảy ra),
`procedural` (chuỗi thao tác đã chứng minh chạy được), `artifact` (nội dung đã
nạp).

Sáu loại cạnh, cái nào cũng mang nghĩa thật: `RESOLVES`, `SUPERSEDES`,
`CONTRADICTS`, `DERIVED_FROM`, `OCCURRED_IN`, `CONSTRAINS`. Cố ý **không** có
`relates_to`.

Mọi node đều mang `source_ref` (`docs/billing.md#L3-L8`). Một ký ức không truy
ngược được là ký ức không kiểm chứng được, mà người ta vẫn sẽ tin nó — nên một
mảnh không có `source_ref` thì **không được ghi**.

Node được cho về hưu, không bị xoá. Ký ức episodic phân rã về trọng số xếp hạng;
ký ức semantic thì không. Phân rã là hạ hạng, không phải xoá.

---

## Riêng tư và an toàn

- **Che secret chạy trước khi nhúng.** Một khi văn bản đã đi qua embedder thì
  vector vẫn mang bí mật, che văn bản gốc sau đó không thay đổi gì. Có test cho
  đúng thứ tự này.
- **Mọi thứ đều cục bộ.** Kho nằm ở `.memory/` và đã gitignore. Model nhúng chạy
  cục bộ qua ONNX; không văn bản nào rời khỏi máy.
- **Ký ức không đi xuyên dự án.** Registry biết mọi dự án, nên truy vấn xuyên
  repo là khả thi về kỹ thuật và **cố ý không cung cấp**.
- **Ghi tự động mặc định tắt.** Đọc là tự động; ghi vào kho của một dự án là thứ
  người dùng phải chủ động bật bằng `MEMORY_LAYER_AUTO_RECORD=1`.

---

## Giới hạn đã biết

- **Khởi động tiến trình vẫn tốn hơn phần việc thật.** `memory --help` mất 318 ms,
  trong đó 225 ms là bản thân node. MCP SDK trước đây nạp ở mọi lệnh, giờ chỉ
  `serve` import nó; binding database nạp khi dùng lần đầu. Phần còn lại là thời
  gian khởi động của node — MCP server sống lâu trả một lần, còn lệnh CLI trả
  mỗi lần.
- **`dai-memory list` tuyến tính theo số dự án.** Chi phí biên đo được 14,5 ms/dự án
  ở mức năm, 20,8 ms ở mức năm mươi, dù pool giới hạn tám: spawn tiến trình trên
  Windows gần như không chồng lấn, nên pool gần như không mua được gì. Năm mươi
  dự án mất khoảng 1,3 s. Dùng được, nhưng không phải mức song song mà code ngụ ý.
- **Tìm kiếm ngữ nghĩa vẫn là quét thẳng.** Không có chỉ mục vector trên các nền
  này, nên chi phí tăng theo số node đã nhúng, dù việc quét giờ diễn ra bên trong
  database.
- **Ngưỡng nhúng là đo được, chưa phải hiệu chỉnh.** Model mặc định là đa ngữ, vì
  một model chỉ-tiếng-Anh chấm văn bản tiếng Việt **không liên quan cao hơn** văn
  bản liên quan — nó xếp theo *ngôn ngữ*, không theo chủ đề, và không ngưỡng nào
  tách được chuyện đó. Model thay thế tách với biên rộng gấp bốn lần ở cùng 384
  chiều. Nhưng con số 0,75 đến từ **năm câu hỏi trên hai tài liệu**: đủ để loại
  một model hỏng, không đủ để gọi là đã hiệu chỉnh. Xem `docs/m0-findings.md`.
- **Trọng số model cache ở `<MEMORY_LAYER_HOME>/models`.** Không nằm trong thư
  mục package, nơi đường dẫn dài tới 279 ký tự dưới pnpm trên Windows và việc tải
  hỏng với thông báo `File doesn't exist` — đọc y hệt như mạng bị chặn, và đã
  từng bị ghi nhận nhầm là vậy. Ghi đè bằng `MEMORY_LAYER_MODEL_CACHE`.
- **Ghi tự động vẫn tắt mặc định.** Nó ghi một ký ức episodic cho **mỗi** lệnh
  thất bại, mà phần lớn thất bại là gõ nhầm. Giờ đã có `dai-memory prune` nên đây là
  một lựa chọn chứ không phải cái bẫy — nhưng hãy bật khi prune đã thành thói
  quen, đừng bật trước.
- **Tóm tắt là do người viết, không sinh tự động.** `dai-memory summarize` lưu tóm
  tắt mà người gọi viết và nối nó vào các thành viên của cụm, nên nó sống sót khi
  cụm được tính lại. Không có gì trên đường đọc gọi model. Đây là ranh giới dự án
  này không vượt để đổi lấy một cái tên đẹp hơn: truy hồi trên các bản tóm tắt
  cụm do máy sinh là một hệ khác, còn cái ở đây là phát hiện cộng đồng kèm một
  chỗ để đặt bản tóm tắt do người viết.
- **Không có watch mode, cố ý.** Một watcher sống lâu sẽ phải giữ kho mở để ghi,
  đúng va chạm reader-vs-writer mà thiết kế này né được bằng cách giữ mọi lệnh
  ghi là tiến trình ngắn hạn. `dai-memory ingest` vốn đã incremental qua `fileHashes`;
  một watcher chỉ mua sự tiện lợi bằng cách trả đi tính chất khiến nhiều phiên
  chạy an toàn.
- **Phân cụm dùng Louvain, không phải Leiden.** Louvain có thể sinh ra cộng đồng
  rời rạc bên trong; Leiden sửa đúng chỗ đó và là thứ các công cụ tương đương
  dùng. Chưa cắn kho thật lần nào, và đổi nó là một thay đổi phụ thuộc chưa ai
  cần tới.
- **Cột web chưa tồn tại.** Sigma.js, front end React và agent LangChain đều chưa
  dựng: kế hoạch nói đừng bắt đầu trước khi CLI xong, và điều đó vẫn đúng.
  Visualization dễ làm và dễ bị nhầm là tiến độ. (`dai-memory ui` đã đủ để nhìn.)
- **Nhúng chạy một luồng.** Worker pool là bước tiếp theo hiển nhiên, nhưng chi
  phí nó tiết kiệm chưa từng được đo. Thêm song song vào một nút thắt chưa đo là
  cách có một chương trình chậm hơn kèm một bug khoá.
- **Lệnh ghi vào nhật ký thì trễ.** Một lệnh ghi thực hiện khi tiến trình khác
  đang giữ khoá sẽ được ghi lại nhưng chưa tìm kiếm được cho tới khi chạy
  `dai-memory merge`. `doctor` báo số lượng đang tồn.
- **Trên Windows, một tiến trình chỉ mở ghi được một lần.** Một đường dẫn
  LadybugDB đã mở để ghi thì không mở ghi lại được trong cùng tiến trình, kể cả
  sau `close()`; lần mở thứ hai bị từ chối như thể tiến trình khác đang giữ khoá,
  mà tiến trình nó nêu tên chính là nó. Handle chỉ-đọc lấy khoá chia sẻ nên không
  bị ảnh hưởng — `search`, `why` và việc reader mở lại sau khi ghi đều bình
  thường.

  Một lệnh CLI ghi một lần rồi thoát nên không bao giờ gặp chuyện này.
  `dai-memory serve` thì có: lần ghi đầu tiên trong phiên được commit, mọi lần sau
  vào nhật ký, báo là `queued` kèm ghi chú, và được `doctor` đếm cho tới khi
  `dai-memory merge` chạy từ một tiến trình khác. Giữ một handle ghi mở suốt đời
  server sẽ bỏ được hàng đợi — phương án đó **đã đo và đã loại**: thoát đột ngột
  sẽ để write-ahead log chưa checkpoint và kho **không mở lại được**, một kiểu
  hỏng tệ hơn nhiều so với một hàng đợi nhìn thấy được. Nhật ký là kiểu xuống cấp
  an toàn hơn, và là kiểu tự báo cáo chính nó.

---

## Cấu hình

| Biến | Tác dụng |
|---|---|
| `MEMORY_LAYER_MODEL_CACHE` | Nơi cache model (mặc định `<MEMORY_LAYER_HOME>/models`) |
| `MEMORY_LAYER_EMBED_DEVICE` | Thiết bị chạy model, ví dụ `dml`, `cuda`. Mặc định `cpu`: thử accelerator hỏng làm process crash lúc thoát |
| `MEMORY_LAYER_DIMS` | Độ rộng vector lúc `init`. Cố định sau đó. |
| `MEMORY_LAYER_HOME` | Registry, log và cache model (mặc định `~/.memory`) |
| `MEMORY_LAYER_MODEL_CACHE` | Trọng số model, nếu cần để chỗ khác |
| `MEMORY_LAYER_OUTPUT_BUDGET` | Trần byte cho output tool MCP (mặc định 24000) |
| `MEMORY_LAYER_AUTO_RECORD` | `1` để hook tự ghi lệnh thất bại |
| `MEMORY_LAYER_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

## Giấy phép

MIT
