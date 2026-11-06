param(
  [Parameter(Mandatory=$true)][string]$Xlsx,
  [Parameter(Mandatory=$true)][string]$Pdf
)
# 注意：本文件必须存成 UTF-8 with BOM（utf-8-sig），否则 PowerShell 会按 ANSI 解析中文路径，
# Excel COM 打开时抛 COMException "无法找到 ..."。
$ErrorActionPreference = "Stop"
$x = New-Object -ComObject Excel.Application
$x.Visible = $false
$x.DisplayAlerts = $false
$wb = $x.Workbooks.Open($Xlsx)
foreach ($i in 1..$wb.Worksheets.Count) {
  $ws = $wb.Worksheets.Item($i)
  $ws.PageSetup.Orientation = 2          # 2 = 横向
  $ws.PageSetup.Zoom = $false
  $ws.PageSetup.FitToPagesWide = 1       # 宽度压到 1 页，否则右边的备注列会被切掉
  $ws.PageSetup.FitToPagesTall = $false
}
$wb.ExportAsFixedFormat(0, $Pdf)         # 0 = xlTypePDF
$wb.Close($false)
$x.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($x) | Out-Null
"ok"
