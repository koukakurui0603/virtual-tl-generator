@echo off
chcp 65001 > nul
echo 仮想TL生成システムを起動します...
if not exist "node_modules" (
    echo 初回準備：必要な部品を自動インストールしています...
    call npm install
)
node ecocute_tl.mjs
pause