@echo off
chcp 65001 >nul
title Claude Skill Team Control Center
cd /d "%~dp0"
node scripts\ctl.mjs start
if errorlevel 1 pause
