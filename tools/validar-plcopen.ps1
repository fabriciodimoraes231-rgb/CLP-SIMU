param(
  [Parameter(Mandatory = $true)][string]$Xsd,
  [Parameter(Mandatory = $true)][string[]]$Xml
)
# Valida arquivos PLCopen XML contra o esquema oficial TC6 XML 2.01, usando o validador do .NET que já vem
# no Windows (nada a instalar). O esquema (tc6_xml_v201.xsd) NÃO acompanha este projeto: obtenha-o à parte
# (veja a seção "Exportar para PLCopen XML" do README).
#
#   pwsh tools/validar-plcopen.ps1 -Xsd caminho/tc6_xml_v201.xsd -Xml saida/*.xml
#   (no Windows PowerShell 5.1: powershell -File tools/validar-plcopen.ps1 ...)
#
# Não resolve URLs externas nem DTD.
# Além dos erros, conta como erro: raiz fora do targetNamespace do esquema e avisos de elemento sem esquema
# fora do conteúdo XHTML (que o PLCopen aceita em modo "lax").
$ErrorActionPreference = 'Stop'
$safe = New-Object System.Xml.XmlReaderSettings
$safe.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
$safe.XmlResolver = $null

$set = New-Object System.Xml.Schema.XmlSchemaSet
$set.XmlResolver = $null
$sr = [System.Xml.XmlReader]::Create($Xsd, $safe)
$schema = $set.Add([NullString]::Value, $sr)  # usa o targetNamespace do próprio esquema
$sr.Close()
$set.Compile()
$ns = $schema.TargetNamespace
Write-Output "Esquema: $Xsd (targetNamespace $ns)"

$Xml = @($Xml | ForEach-Object { Get-ChildItem -Path $_ | ForEach-Object FullName })
$totalErrors = 0
foreach ($f in $Xml) {
  $script:errs = New-Object System.Collections.Generic.List[string]
  $script:lax = 0
  $vs = New-Object System.Xml.XmlReaderSettings
  $vs.ValidationType = [System.Xml.ValidationType]::Schema
  $vs.Schemas = $set
  $vs.ValidationFlags = [System.Xml.Schema.XmlSchemaValidationFlags]::ReportValidationWarnings
  $vs.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $vs.XmlResolver = $null
  $vs.add_ValidationEventHandler({
    param($s, $e)
    $where = 'linha {0}, col {1}' -f $e.Exception.LineNumber, $e.Exception.LinePosition
    if ($e.Severity -eq [System.Xml.Schema.XmlSeverityType]::Error) {
      $script:errs.Add("${where}: $($e.Message)")
    } elseif ($e.Message -match 'http://www\.w3\.org/1999/xhtml') {
      $script:lax++  # conteúdo XHTML livre (formattedText), validado em modo lax
    } else {
      $script:errs.Add("${where}: (aviso tratado como erro) $($e.Message)")
    }
  })
  $r = [System.Xml.XmlReader]::Create($f, $vs)
  $rootChecked = $false
  try {
    while ($r.Read()) {
      if (-not $rootChecked -and $r.NodeType -eq [System.Xml.XmlNodeType]::Element) {
        $rootChecked = $true
        if ($r.NamespaceURI -ne $ns) { $script:errs.Add("raiz <$($r.Name)> no namespace '$($r.NamespaceURI)', esperado '$ns'") }
      }
    }
  } catch { $script:errs.Add("ERRO FATAL: $($_.Exception.Message)") } finally { $r.Close() }
  $name = Split-Path $f -Leaf
  if ($script:errs.Count -eq 0) {
    Write-Output ("OK      {0} (elementos XHTML em modo lax: {1})" -f $name, $script:lax)
  } else {
    Write-Output ("FALHOU  {0}: {1} erro(s)" -f $name, $script:errs.Count)
    $script:errs | Select-Object -First 5 | ForEach-Object { Write-Output "        $_" }
  }
  $totalErrors += $script:errs.Count
}
Write-Output "Total de erros: $totalErrors"
if ($totalErrors -gt 0) { exit 1 }
