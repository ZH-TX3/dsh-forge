# 工具链路由

## 规则

选工具看**两个独立的轴**，别混：

| 轴 | 由什么决定 | 影响 |
|---|---|---|
| **目标平台** | 被分析/被修改的东西本身是什么格式 | 用哪套工具、哪套格式知识、哪套调用约定 |
| **执行位置** | 这套工具在哪台机器上跑 | 能不能真的跑；跑不了就是"未验证"，不是"不该用" |

顺序固定：**先定目标平台 → 选工具链 → 再定执行位置**。

反例（我犯过的）：看到本机是 Windows，就把 macOS 的活判成"不适用"。
正确的说法是：目标平台是 macOS → 工具链是 lldb / otool / SBPL → 执行位置不可用（需要 mac 主机），
所以结论是**这套活能写、跑不起来**，而不是"不需要这套工具"。

## 目标平台 → 工具链

| 环节 | Windows（PE/COFF, .NET） | Linux（ELF） | macOS（Mach-O） |
|---|---|---|---|
| 格式识别 | PE-bear、CFF Explorer、`dumpbin /headers` | `readelf -a`、`objdump -x`、`file` | `otool -l`、`nm`、`lipo -info`、`vmmap` |
| 静态反汇编 | IDA、Ghidra、x64dbg 的 CPU 视图 | Ghidra、rizin/radare2、`objdump -d` | Ghidra、Hopper、`otool -tv` |
| 动态调试 | **x64dbg**（+ScyllaHide）、WinDbg、IDA debugger | **gdb**（+pwndbg/gef）、`rr` | **lldb**（+`script` 桥）、`dtrace` |
| 内存 | Cheat Engine、Process Hacker、`ReadProcessMemory` | `/proc/<pid>/maps`、`gdb` 的 `info proc mappings` | `vmmap`、`lldb` 的 `memory read` |
| .NET / 托管 | **dnSpy**、ILSpy、`ildasm` | （Mono: `monodis`） | （同上，跨平台） |
| 注入 / Hook | LoadLibrary、manual mapping、IAT/VMT、Detours | `ptrace`、`LD_PRELOAD`、`seccomp` | `task_for_pid`、`DYLD_INSERT_LIBRARIES` |
| 沙箱 / 围栏 | ACL restricted token、AppContainer | bwrap、landlock、seccomp | Seatbelt（SBPL）、`sandbox-exec` |
| 签名 / 完整性 | Authenticode、`signtool` | 无（走 IMA/dm-verity） | `codesign`、`spctl`、SIP/TCC |
| 脚本库 | `pefile`、`capstone`、`unicorn`、`pywin32` | `pwntools`、`pyelftools`、`capstone`、`angr` | `macholib`、`capstone`、`lief` |

**跨平台通用**：Ghidra、rizin/radare2、capstone / keystone / unicorn、lief、YARA、binwalk、Frida（前端跨平台，后端各平台自备）。

## 执行位置 → 可用性

| 目标平台 | 本机（Windows + Git Bash） | docker | 需要 mac 主机 |
|---|---|---|---|
| Windows PE | ✅ 原生（x64dbg / IDA / CE / PE-bear） | ⚠️ wine 只能跑不能调 | — |
| Linux ELF | ⚠️ 只能静态看（Ghidra 有，gdb 无） | ✅ 完整（gdb / pwntools / strace） | — |
| macOS Mach-O | ⚠️ 静态可看（Ghidra / lief） | ❌ | ✅ 唯一能动态调的地方 |

**结论写法**：跑得起来才叫"验证过"。跑不起来的，产物要落成脚本 + 说明，标 `未验证（需 <平台> 主机）`，
不许写"应该可以"。

## 本机现状（实测）

- 有：Windows 原生工具链可用；docker 可用；Node v24。
- 没有：lldb、frida（本机都没装）。
- 因此：macOS 动态调试与注入相关的活 → 出脚本，标未验证。

## 落成文件的要求

看不见屏幕，所以每个"看见"都必须是文件：

| 要看的东西 | 落成什么 |
|---|---|
| 内存/寄存器现场 | 文本 dump（`x/64gx`、`mem read` 输出）、`.dmp` |
| 反汇编 | 带地址与偏移的文本片段 |
| 调用链 | 栈回溯文本 |
| 行为 | 抓包文件、日志文件、`strace`/`ETW` 输出 |
| UI 状态 | 结构化 JSON / 渲染后的文本（不是截图） |

截图只在需要人看时才有意义；判断依据永远是文件内容。
