# 飞书 Auto-Cut 三阶段素材交接设计

状态：已完成需求确认、设计审批和实施计划，进入隔离 worktree 实施。

日期：2026-09-06

## 1. 目标与已确认决策

本设计把飞书学科子表中的状态变化，可靠地连接到 Auto-Cut-lite 的一次具体运行和一个具体 ZIP。系统不扫描目录、不按文件名猜任务、不选择“最新 ZIP”，也不把飞书单元格内容当作本地路径、命令或 prompt。

已确认的首版决策：

- 只接受 Bridge 通过 Taskboard 专用接口登记的受信任飞书任务。
- 每个学科固定一个状态单选字段，并用三个固定阶段区分 `初稿`、`初审修改`、`终审修改`。
- 三个阶段结构一致、开关和输入规则独立，至少启用一个阶段；同一状态字段上的三个目标选项不能重复。
- 阶段触发只认“从其他值进入该阶段目标值”。阶段关闭期间不补执行；记录必须先离开目标值，再重新进入才会再次触发。
- 每条记录的“集合文档”字段只含一个飞书文档链接，可以是直接 Docx URL 或 Wiki 文档 URL；三个阶段共用该文档，但各自使用自己的素材和意见位置。
- 视频、音频可以来自该飞书文档的指定目录文字，也可以来自 Base 原生附件字段。文档内多个媒体按从上到下的出现顺序一一对应；数量或时长明显不合理时暂停，不猜测、不按文件名或时长重新排序。
- 外部音频替换视频原音时，音频来源必填，默认时长容差为 3 秒且每阶段可调；使用视频原音时不配置音频来源。
- 三个阶段都从自己的完整输入重新开始，不继承前一阶段的 ZIP。
- 学科共用执行模式、Auto-Cut 包和上传入队策略；Auto-Cut 包剪辑并发保持 `maxConcurrent=1`，上传队列继续使用独立并发配置。
- 每阶段有独立的 ZIP 本地/NAS 目标目录和命名后缀。基础名称来自学科命名字段的普通文本或文本结果公式，字段结果保证唯一；默认后缀为 `_初稿`、`_初审修改`、`_终审修改`。
- 自动模式在任务进入“待处理”后沿用现有约 5 秒延时，成功后按任务创建时冻结的 `enqueueMode` 自动入上传队列；手动模式保持现有行为。
- 素材或文档问题使任务进入阻塞并显示明确原因。用户修正来源后，在 Taskboard 点击“重试 Auto-Cut”；旧运行保留，新运行重新读取完整输入，不沿用旧 ZIP。
- 当前任务 `FEI-10` 继续暂停；本设计不恢复任务、不回写飞书记录。

## 2. 现有真实路径与现状差距

### 2.1 当前可证明的操作路径

当前系统的真实入口和副作用路径是：

`飞书官方 SDK 记录变更事件`
-> `codex-feishu/src/feishu-event.mjs` 归一化表、记录、字段以及 before/after 值
-> `codex-feishu/src/decide-event.mjs` 按已启用 subject 的触发字段和值判定
-> `codex-feishu/src/bridge.mjs` 以事件锁和持久化租约去重，再调用
`POST /api/local/feishu/tasks`
-> `dashi-taskboard/server/app.mjs` 验证 loopback client/secret、创建 Feishu task 和包快照
-> `server/feishu-execution-coordinator.mjs` 将 automatic 任务放入 `autocut:<packageAlias>` 调度组
-> `server/app.mjs` 的 `startClaimedTaskWithAi` 创建 AI run，并在 `onRunCreated` 注入现有的 run-scoped artifact-report 能力
-> Auto-Cut 完成后调用现有 `driver_report`
-> `server/app.mjs` 校验精确 ZIP 路径、任务/run/token、来源目录和 SHA-256，并执行已有完成/上传队列逻辑。

关键代码位置：

- 事件归一化：`D:\\codex\\codex-feishu\\src\\feishu-event.mjs:111-201`。
- Bridge 决策、租约和专用任务登记：`D:\\codex\\codex-feishu\\src\\bridge.mjs:385-519`。
- Taskboard 专用登记入口：`D:\\codex\\dashi-taskboard\\server\\app.mjs:4541-4596`。
- 自动执行启动：`D:\\codex\\dashi-taskboard\\server\\app.mjs:3366-3542`。
- 并发调度：`D:\\codex\\dashi-taskboard\\server\\feishu-execution-coordinator.mjs:167-295` 和 `server\\resource-scheduler.mjs:87-103`。
- 精确产物报告入口：`D:\\codex\\dashi-taskboard\\server\\app.mjs:2945-2950` 及 `4956` 附近的 artifact-report 路由。

### 2.2 本次功能尚未存在的部分

只读审计确认，当前代码还没有：

- 三阶段素材配置和“集合文档/命名字段”配置落点；
- Taskboard 生成运行清单的实现；
- Auto-Cut-lite 的 `--source-manifest` 入口；
- 按指定 Docx 目录解析附件、按文档顺序配对和 Base 附件读取；
- 登记时对服务器保存的 `subjectKey + configVersion + stageId` 做强校验和事件唯一约束；
- 缺失 before/after 时的 fail-closed 处理。

现有登记接口只校验 loopback/共享密钥、描述标记中的部分来源字段、项目哈希、状态和标签，不能把 Bridge 认证本身当成字段真实性证明。本设计把这些内容列为必须补齐的实现边界，而不是假定它们已经完成。

## 3. 方案比较

### 方案 A：扫描 ZIP 目录并选择最新文件

实现简单，但无法证明 ZIP 属于哪一次任务或 run；并发、重试和同名产物会造成误绑定。违反“不按最新 ZIP 猜测”的硬约束，淘汰。

### 方案 B：Taskboard/Bridge 直接下载全部素材并把本地路径交给 Auto-Cut

可以减少 Auto-Cut 的读取工作，但会把飞书用户身份、文档解析和媒体下载职责放到宿主侧，且容易把来源路径混入普通任务上下文。它也不能自然复用 Auto-Cut-lite 当前的用户身份读取能力，淘汰。

### 方案 C：结构化、run 专用的来源清单（采用）

Taskboard 根据受信任任务和冻结配置生成一份清单，清单只描述任务/阶段、文档链接、目录文字和受控 Base 字段标识。Auto-Cut-lite 通过自己的已授权用户身份按清单读取和下载，随后在同一个 run 内生成 canonical snapshot/project、完成剪辑并返回实际 ZIP。清单哈希进入 run identity，既能保持职责边界，也能避免目录扫描和旧缓存误用。

## 4. 目标操作路径

目标路径为：

`飞书状态字段从其他值变为阶段目标值`
-> `Bridge 读取该事件和当前记录的受控字段，使用应用身份`
-> `Bridge 只通过专用 loopback 接口提交 eventId、subjectKey、configVersion、stageId 及 Base/table/record 标识`
-> `Taskboard 在服务器端重新验证该 subject 版本、阶段、触发字段、包白名单和项目归属，并用 eventId 幂等登记`
-> `任务固定阶段配置快照`
-> `automatic` 模式延迟约 5 秒进入现有 Auto-Cut 调度器（包并发为 1）
-> `Taskboard 为 task/run 创建独立来源清单和执行命名输入`
-> `Auto-Cut-lite 以用户身份读取 Docx 或 Base 附件，按清单解析并下载素材`
-> `Auto-Cut-lite 完成剪辑、验收并生成完整剪映草稿 ZIP`
-> `Auto-Cut 从成功 JSON 读取本次实际 package_zip 的绝对路径和 SHA-256`
-> `driver_report` 提交精确路径、哈希及运行凭据
-> `Taskboard 验证任务/run/阶段/配置版本归属、ZIP 结构和哈希`
-> `automatic` 任务完成并在冻结的 `enqueueMode=automatic` 时入上传队列。

可观察结果是一条绑定同一 `taskId + runId + stageId + configVersion` 的已验收 ZIP，以及最多一条对应的自动上传队列记录。任何来源问题在 Auto-Cut 启动前或素材阶段进入阻塞，不产生伪造产物。

## 5. 信任边界与身份

### Bridge

- 继续使用飞书应用身份监听官方 SDK 长连接并读取当前记录的受控字段。
- 负责确认事件属于已启用 subject、补全事件里没有携带的当前文档链接/命名结果/受控字段值，并生成稳定的事件指纹。
- 只向 Taskboard 发送 opaque 的 Base/table/record/field 标识和配置版本，不发送本地路径、shell 命令或 prompt。
- 只调用 `127.0.0.1` 的专用登记路由，携带启动脚本注入的 Bridge secret；不启动 Codex，不回写飞书。

### Taskboard

- 通过 loopback、client header 和共享密钥认证 Bridge，但不把认证当作业务字段真实性；登记时必须再查服务器保存的 subject 版本。
- 从 `feishu_subject_versions` 和本机 Auto-Cut 包白名单派生执行模式、阶段配置、包、并发和上传策略，不接受请求正文自报的 automatic/manual、包名或路径。
- 生成 task/run 专用清单和 `execution_input.json`，并把清单摘要写入运行身份；不把飞书单元格文本当作可执行输入。
- 持有 artifact-report capability 的短生命周期 token，验证精确 ZIP 后才改变任务完成状态或入上传队列。

### Auto-Cut-lite

- 使用本机已经授权的飞书用户身份执行只读 Docx、Wiki/Docx 资源和 Base 附件读取；用户凭据不写进 prompt、任务描述或 manifest 的可执行字段。
- 接收 `--source-manifest` 和现有 `--execution-input` 两个受控本地文件，不再扫描整篇文档寻找“可能的视频”，也不选择最新 ZIP。
- 只在 run 专用目录下载和处理中间文件，并在运行 receipt 中记录文档修订、素材 SHA-256、配对和验收结果。

## 6. 学科配置模型

阶段配置位于现有学科 subject 配置下；执行模式、单一 Auto-Cut 包和上传策略仍是学科公共配置。建议结构如下：

```text
subject
├─ statusField                 共同的状态单选字段及字段/选项快照
├─ documentField              共同的集合文档字段，只允许一个 Docx 或 Wiki 文档链接
├─ namingField                共同的命名字段
├─ stages
│  ├─ initial                 初稿
│  ├─ firstReview             初审修改
│  └─ finalReview             终审修改
├─ execution                  manual / automatic；包并发保持 1
├─ packageRoute               单一受信任 Auto-Cut 包
└─ upload                     enqueueMode 和公共存储目标
```

每个阶段至少包含：

- `enabled`：独立启用开关；至少一个阶段开启。
- `trigger`：从共同状态字段实际选项中选取的 option ID 和显示值；三个启用阶段不得选同一 option。
- `videoSource`：`docx_section(anchorText)` 或 `base_attachment(fieldId)`。
- `reviewSource`：首版为共同飞书文档中的 `docx_section(anchorText)`；空意见不执行。
- `audio`：`video_original` 或 `replace_original`。替换模式必须有 `docx_section` 或唯一 `base_attachment` 来源及 `durationToleranceSeconds`，默认 3 秒。
- `artifactTargetPath`：本地白名单/配置中的绝对目录；不来自飞书单元格。
- `nameSuffix`：该阶段追加到命名字段结果后的后缀。

启用前必须用最新 Base metadata 校验状态字段确实为单选、字段仍存在、option ID 与显示值一致、文档字段和命名字段类型可读、阶段触发选项不冲突、目标目录属于本机允许范围、包别名存在且启用。保存 subject 时产生新的本地 `configVersion` 和不可变版本快照。任务登记时只引用这个版本，不引用随后修改的 subject。

## 7. 触发和事件语义

### 7.1 必须证明状态边沿

Bridge 只把以下事件判为阶段触发：

```text
beforeValue != stage.trigger.value
afterValue  == stage.trigger.value
```

`beforeValue` 和 `afterValue` 都必须来自同一配置的真实字段 ID。缺少任一值、字段 ID 不匹配、值无法从选项 ID 映射到唯一显示值时，事件记为阻塞/不登记，不把空值当作“其他值”。用户必须先让记录离开目标值，再重新进入。

以下情况不创建任务：

- after 不是任何启用阶段的目标值；
- before 已经是同一目标值；
- 阶段关闭，或 subject 没有有效活动版本；
- 事件来自未知 Base/table/字段；
- 只有描述标记、`feishu` 标签或普通任务 API，没有 Bridge 专用登记凭据。

离开目标值的事件继续沿用现有只归档匹配 `todo` 等待任务的行为，不自动中止 `in_progress`、`in_review` 或 `done` 任务。

### 7.2 配置修改与延迟事件

Bridge 在副作用前保存事件决策快照。若状态边沿发生时阶段处于开启状态，即使 Taskboard 登记前用户关闭了该阶段，也使用事件携带的有效 `configVersion` 登记并冻结该版本；关闭只影响之后的新事件。没有有效版本或版本从未处于启用状态的请求一律拒绝。

### 7.3 幂等和完整字段

Taskboard 为 `(baseToken, tableId, recordId, triggerFieldId, stageId, eventId)` 建立唯一登记语义。重复投递返回已有任务，不创建第二条。若 SDK 只提供变化字段，Bridge 必须用应用身份读取当前记录补全文档、命名和其他受控字段；不能因字段未出现在 after payload 就把任务判为缺少包或素材。

## 8. 运行清单契约

每个 run 只生成一份 canonical、不可变的 `source-manifest.json`。示意结构：

```json
{
  "schema_version": 1,
  "binding": {
    "task_id": "FEI-10",
    "run_id": "run-id",
    "subject_key": "base:table",
    "config_version": 12,
    "stage_id": "initial",
    "event_id": "feishu-event-id"
  },
  "document": {
    "field_id": "fld_document",
    "url": "https://example.feishu.cn/docx/opaque-token"
  },
  "sources": {
    "video": {"kind": "docx_section", "anchor_text": "录屏"},
    "review": {"kind": "docx_section", "anchor_text": "修改意见"},
    "audio": {
      "mode": "replace_original",
      "duration_tolerance_seconds": 3,
      "source": {
        "kind": "base_attachment",
        "base_token": "opaque-base",
        "table_id": "tbl",
        "record_id": "rec",
        "field_id": "fld_audio"
      }
    }
  }
}
```

契约约束：

- `document.url` 只允许经过校验的官方 HTTPS 飞书 Docx URL 或 Wiki 文档 URL；一个字段出现零个或多个链接都阻塞。
- `docx_section.anchor_text` 去除首尾空格后完全匹配，不做模糊、同义词或大小写猜测。
- Base 来源只传 opaque 标识；附件字段预期唯一，多个附件阻塞，不选第一个。
- 清单不允许 shell、可执行路径、prompt、凭据或由单元格拼出的目录。
- 清单 canonical JSON 的 SHA-256 纳入 runner job identity；同一文档换阶段位置、附件字段或配置版本不能复用旧缓存。
- 清单、下载文件和 Auto-Cut 产物放在 task/run 独占目录；重试使用新 run 目录。

产物命名另由现有 `execution_input.json` 传递，格式保持：

```json
{"schema_version": 1, "artifact_name": "基础名称_初稿"}
```

Taskboard 先读取命名字段的已计算结果，验证非空和唯一，再按阶段追加后缀；Auto-Cut-lite 的既有命名清理逻辑同时控制剪映草稿目录名和最终 ZIP 文件名。

## 9. Docx 和 Base 素材解析

### 9.1 Docx 目录范围

标题和独立普通/加粗文本行都可以作为锚点。匹配前只去除首尾空格，正文必须完全相等。命中后递归包含其下所有层级的子标题和附件，直到遇到下一个同级或更高层级标题或下一个配置标签。

范围内附件默认全部下载，保留原文件名；重名自动编号。根据扩展名或 MIME 归类为视频或音频，无法归类的文件不能静默丢弃，应在任务中显示原因。

多个视频和音频按文档从上到下的出现顺序一一对应。数量不一致、媒体无法下载或时长超出阶段容差时阻塞；首版不按文件名、文件大小、修改时间或时长重新排序。

### 9.2 Base 原生附件

Base 附件来源通过字段 ID 读取。首版按已确认的实际使用方式支持唯一视频或唯一音频；字段为空、附件超过一个、下载失败或 MIME/扩展名无法识别时阻塞。不会把附件显示名转换成本地路径。

### 9.3 声音处理和意见

- `video_original`：不读取音频来源，使用视频原音。
- `replace_original`：音频来源必填；Auto-Cut-lite 静音视频原音，并把外部音频按输入规则对齐。
- 剪辑意见只从配置的 Docx 意见目录读取；不把 Base 普通文本当作剪辑指令。
- 意见位置不存在、范围没有可执行意见或意见为空时阻塞并显示阶段、锚点和原因。

## 10. Auto-Cut-lite 接口和并发

Auto-Cut-lite 在现有 `review-document-run` 上新增 `--source-manifest <json>` 入口，保留 `--execution-input` 作为命名输入。现有 `--doc-url` 兼容入口不再用于本流程的自动素材猜测。

运行步骤：

1. 读取并严格校验 manifest 的 binding、阶段、来源种类和 schema。
2. 使用 Auto-Cut-lite 配置的已授权用户身份，按 document URL、Docx 锚点和 Base 字段标识读取素材。
3. 下载到 run 专用目录，记录原文件名、MIME、大小和 SHA-256。
4. 生成 canonical snapshot/project，执行现有 Lite 剪辑和验收。
5. 从成功 JSON 的 `data.package_zip` 或 `data.output_artifacts.package_zip` 读取实际绝对 ZIP 路径、大小和 SHA；不从目录查找候选文件。

Taskboard 为每个 run 提供唯一 `job_root`、阶段 ZIP 输出目录和目标文件名。Auto-Cut-lite 已有的缓存锁可共享，但运行身份必须包含完整 manifest 摘要。剪映草稿根目录和同名草稿覆盖/保留清理仍是共享资源，因此首版每个 Auto-Cut 包的完整剪辑并发固定为 `1`。上传复制队列不占用该剪辑租约，可按现有上传并发配置并行。

## 11. 产物登记和任务状态

`driver_report` 仍是唯一产物登记入口。报告必须包含：

- Taskboard 注入的短期 run/token；
- 当前 `taskId`、`runId` 和阶段 binding；
- Auto-Cut 成功 JSON 返回的精确 ZIP 绝对路径；
- 报告方重新计算的 ZIP SHA-256 和大小；
- 需要时的 draft/name receipt。

Taskboard 在登记前验证：

- 任务确实由专用 Bridge 路由创建，来源为 Feishu，且 `subjectKey/configVersion/stageId/eventId` 与服务器快照一致；
- 报告 token 属于同一任务和 run，不能跨任务、跨阶段或跨版本使用；
- ZIP 位于该包允许的来源目录，文件名与已验收草稿名一致，ZIP CRC/结构、receipt 和 SHA-256 全部通过；
- 同一 run 不重复登记，不覆盖已有不同内容的 ZIP。

自动模式通过全部校验后沿用现有流程完成任务，并只在该任务创建时冻结的 `enqueueMode` 为 `automatic` 时入队。手动模式继续使用人工选择 ZIP 和人工验收，不因新增 manifest 改变行为。

## 12. 阻塞、重试和恢复

下列问题统一进入阶段级阻塞：状态/配置版本无效、文档链接不唯一、锚点不存在、范围无附件、Base 附件不唯一、下载失败、媒体数量不一致、时长异常、意见为空、命名为空/不唯一、manifest/hash/binding 校验失败或 Auto-Cut 验收失败。

阻塞任务展示：学科、记录、阶段、运行 ID、失败阶段、稳定错误码和可读原因。系统不自动猜测、不从其他阶段借用素材、不自动循环重试、不上传不完整 ZIP。

用户修正来源后点击“重试 Auto-Cut”：

- 原任务 ID 和原始阶段配置快照保留；
- 新建单调递增的 run ID 和新的清单/下载目录；
- 重新读取当前文档/附件并重新计算哈希；
- 旧 run 只作为审计记录，不被新 ZIP 覆盖；
- 自动模式的重试也必须由该按钮明确发起。

### 12.1 单次运行的外部 ASR 与本地写入授权

当受信任的 phased Auto-Cut 任务因执行代理缺少逐次授权而阻塞时，重试请求可以额外携带结构化的 `runConsent`：

```json
{
  "version": 16,
  "runConsent": {
    "allowVideoAudioAsr": true,
    "allowConfiguredLocalOutput": true
  }
}
```

该授权遵循以下边界：

- 只由 `POST /api/local/tasks/:id/autocut-retry` 接受，且仍须先通过 loopback、任务版本、`blocked` 状态、服务器登记的 Feishu origin 和 phased Auto-Cut 快照校验；普通任务、复制描述标记或 legacy 任务不能使用。
- 两个字段都只能是布尔值；不接受授权自由文本、服务地址、输出路径、命令或 prompt。服务地址固定为 `openspeech.bytedance.com`，输出位置仍只来自 Taskboard 为该 run 注入的受控路径。
- 授权只随本次 retry 调度到新 run。服务端生成固定说明，明确只允许从当前受信任清单的视频提取音频并发送至该 ASR 服务，用于字词级定位和验收，同时允许写入该 run 的配置草稿和 ZIP 路径。
- 不读取 Taskboard 评论、任务描述或飞书单元格作为授权来源，也不修改学科配置或 Auto-Cut 包提示词；评论可以作为审计记录，但不能取得执行资格。
- 未携带 `runConsent` 的现有重试保持原行为；携带不完整、为 `false`、含未知字段或用于不合格任务的请求在创建新 run 前拒绝。
- 授权说明只进入该 run 的服务端私有执行上下文，并随 AI run 的用户事件留痕；不得继承到后续 retry、其他课程或其他任务。

直接操作路径为：

`POST /api/local/tasks/:id/autocut-retry` 携带 `version + runConsent`
-> `server/app.mjs` 校验受信任任务、版本和结构化授权
-> `server/feishu-execution-coordinator.mjs` 在本次调度项中传递授权
-> `server/app.mjs` 的 `startClaimedTaskWithAi` 为新 run 生成固定授权说明
-> `server/ai-chat-process.mjs` 将其放入该 run 的私有 Taskboard 上下文
-> Auto-Cut 只按 server-owned manifest、执行输入和输出路径运行
-> 仍由精确 `driver_report` 完成 ZIP 登记和 automatic 上传入队。

Bridge 的事件租约、至少一次投递和 dead-letter 机制继续保留。Taskboard 或 Auto-Cut 重启后只恢复有明确 run 状态的工作，不扫描临时目录或收养孤立 ZIP。

## 13. API、持久化和组件改动范围

实现时优先扩展现有边界，不创建独立工具：

- `codex-feishu`：扩展 workflow 配置、事件决策和任务 payload，补齐当前记录读取、阶段映射、缺失 before/after 的阻塞语义，并继续使用现有 Bridge 专用登记接口。
- Taskboard `server/feishu-workflow-store.mjs`、数据库和 API：增加 status/document/naming/stages 契约验证、版本快照和登记 CAS/唯一事件语义；登记时从服务器快照派生执行字段。
- Taskboard `server/app.mjs`、AI run 注入和相关客户端：在 run 创建时生成清单和命名输入，传递受控本地文件路径，保留现有 report capability 和自动入队边界。
- Auto-Cut-lite `runtime/scripts/cli/jy_wrapper_parser.py`、`review_document_intake.py`、`review_document_runner.py` 及相关模型：实现 `--source-manifest`、结构化 Docx/Base 来源读取、顺序配对、声音模式、时长容差和 manifest identity；保留现有 `execution_input` 命名协议。
- 不增加飞书回写接口，不改变 Bridge/Taskboard 的 `127.0.0.1` 监听，不把单元格内容提升为命令或 prompt。

## 14. 自动化测试与 README

测试按真实边界分层：

### Bridge

- 真实 field ID 的 before/after 边沿、缺失值 fail-closed、option ID 映射和阶段冲突；
- 关闭阶段不补执行，离开后重新进入才触发；
- 事件重放、跨实例 lease、重复 event ID 只有一个登记；
- SDK 只携带变更字段时能补全受控记录字段；
- stale configVersion 使用已捕获的有效快照，伪造/未启用版本被拒绝。

### Taskboard

- 专用 loopback/secret 之外的请求、普通任务、描述标记和标签不能获得 Auto-Cut 资格；
- 登记必须匹配 subjectKey、configVersion、stageId、trigger option、package snapshot 和派生项目；
- 重复 event ID 的原子幂等；禁用/草稿 subject 和缺字段 metadata 的拒绝；
- 每个 run 的清单、命名输入和 report capability 互相隔离；
- exact path、SHA、ZIP 结构和任务/run/阶段归属校验；automatic 完成/入队与 manual 行为保持差异；
- `maxConcurrent=1` 时第二个同包 run 排队，上传队列仍可并行。

### Auto-Cut-lite

- manifest schema、binding/hash identity、Docx 锚点范围和独立文本标题；
- 多视频/音频文档顺序配对、数量不一致阻塞、原文件名保留和重名编号；
- 唯一 Base 附件、视频原音/外部音频、默认及自定义时长容差；
- 意见为空、下载失败、媒体变化和命名输入错误的失败结果；
- 成功 JSON 返回的精确 ZIP 路径、receipt、SHA 与运行目录隔离；
- 两个不同 run 使用唯一 job root 时不串数据；共享剪映根仍由包级串行调度保护。

README 更新内容：配置三个阶段、字段选择和锚点规则；运行清单和用户身份边界；阶段阻塞/重试；精确 `driver_report`；上传与剪辑并发的区别；不支持目录扫描、最新 ZIP 推断、飞书回写和单元格命令。

## 15. 直接验证、风险和非目标

本功能属于高风险跨边界改动，原因包括本机 Bridge、持久化版本、用户身份读取、外部文档/附件、Auto-Cut 进程、剪映共享目录和上传状态。

实施后的直接验证只覆盖真实主路径和一个失败路径：

1. 在测试学科配置中启用一个阶段，用真实状态边沿创建一个受信任 automatic 任务，确认任务绑定的阶段/版本、清单内容、用户身份读取、成功 ZIP 精确路径和 SHA、同一 run 的 report、任务完成以及一条上传队列记录。
2. 使用普通任务或缺失/歧义素材，确认 Auto-Cut 不启动、不登记 ZIP，Taskboard 显示稳定阻塞原因；修正后点击重试，确认新 run 成功且旧 run 保留。

以下不在第一阶段：

- 按学科代码选择多个 Auto-Cut 包或分支；
- 多个 Base 附件的自动配对规则；
- 按文件名语义、时长排序或“最像的文件”猜测；
- 完全并行的剪辑执行；
- 目录监听、最新 ZIP 发现或飞书记录回写；
- 阶段之间继承前一阶段的草稿或 ZIP。
