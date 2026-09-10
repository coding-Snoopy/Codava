# PowerShell 配置文件
# 用于修复中文乱码问题

# 设置控制台编码为 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

# 设置当前会话的 PreferredEncoding
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

Write-Host "PowerShell 编码已设置为 UTF-8" -ForegroundColor Green
