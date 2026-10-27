# electron-builder 自定义 NSIS 片段（nsis.include 指到这里）
#
# 三件事：
#   1. 安装时勾选是否创建开始菜单 / 桌面快捷方式
#   2. 卸载时询问是否删除用户数据
#   3. 卸载后回收安装目录与空的父目录，目录被占用时交给副本进程延迟重试
#
# installer.nsi 会被编译两遍（安装包 / 卸载程序），靠 BUILD_UNINSTALLER 区分。

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

# installer.nsi 被编译两遍， makensis 默认带 -WX（nsis.warningsAsErrors 不为 false 时），
# 所以"变量声明了没用到"这种 warning 6001 会直接把构建打挂：变量必须按遍分开放。
!ifdef BUILD_UNINSTALLER
  Var /GLOBAL lpDeleteUserData
  Var /GLOBAL lpHDeleteData
  Var /GLOBAL lpCleanDir
  Var /GLOBAL lpParent
!else
  Var /GLOBAL lpStartMenu
  Var /GLOBAL lpDesktop
  Var /GLOBAL lpHStartMenu
  Var /GLOBAL lpHDesktop
!endif

# ============================ 安装 ============================
# 插入点：选完安装目录之后、开始安装之前
!macro customPageAfterChangeDir
  Function LpOptionsPageCreate
    # 静默 / 自动更新不走这一页；没进过页面时 lpStartMenu/lpDesktop 保持 customInit 的默认值
    ${if} ${Silent}
      Abort
    ${endif}

    !insertmacro MUI_HEADER_TEXT "附加选项" "选择要创建的快捷方式"
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}

    ${NSD_CreateCheckbox} 0 0 100% 12u "在开始菜单创建快捷方式"
    Pop $lpHStartMenu
    ${NSD_SetState} $lpHStartMenu ${BST_CHECKED}

    ${NSD_CreateCheckbox} 0 22u 100% 12u "在桌面创建快捷方式"
    Pop $lpHDesktop
    ${NSD_SetState} $lpHDesktop ${BST_CHECKED}

    nsDialogs::Show
  FunctionEnd

  Function LpOptionsPageLeave
    ${NSD_GetState} $lpHStartMenu $1
    ${if} $1 == ${BST_CHECKED}
      StrCpy $lpStartMenu "1"
    ${else}
      StrCpy $lpStartMenu "0"
    ${endif}

    ${NSD_GetState} $lpHDesktop $1
    ${if} $1 == ${BST_CHECKED}
      StrCpy $lpDesktop "1"
    ${else}
      StrCpy $lpDesktop "0"
    ${endif}
  FunctionEnd

  Page custom LpOptionsPageCreate LpOptionsPageLeave
!macroend

# customInit 只在安装遍的 .onInit 里插入，卸载遍不会执行
!macro customInit
  StrCpy $lpStartMenu "1"
  StrCpy $lpDesktop "1"
!macroend

# 快捷方式由内置宏先建好，这里按勾选结果删掉不想要的部分
!macro customInstall
  ${if} $lpStartMenu == "0"
    ${if} ${FileExists} "$newStartMenuLink"
      WinShell::UninstShortcut "$newStartMenuLink"
      Delete "$newStartMenuLink"
    ${endif}
    # menuCategory 生成过菜单文件夹时，空了就一并回收
    ReadRegStr $1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" MenuDirectory
    ${if} $1 != ""
      RMDir "$SMPROGRAMS\$1"
    ${endif}
  ${endIf}

  ${if} $lpDesktop == "0"
    ${if} ${FileExists} "$newDesktopLink"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${endif}
  ${endIf}

  # 完成页"运行 LightPlayer"的链接来自开始菜单快捷方式，被删掉后要退回可执行文件
  ${ifNot} ${FileExists} "$newStartMenuLink"
    StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${endIf}
!macroend

# ============================ 卸载 ============================
# 卸载页顺序：Welcome -> 这一页 -> 安装模式 -> 进度 -> 完成
!macro customUnWelcomePage
  # 先展开 MUI 欢迎页：它会生成 MUI_INTERFACE，$mui.Header.* 变量必须在下面函数体之前声明
  !insertmacro MUI_UNPAGE_WELCOME

  Function un.LpUserDataPageCreate
    # 静默卸载（含自动更新触发的）不弹这一页；此时由 customUnInit 兜底判定
    ${if} ${Silent}
      Abort
    ${endif}

    # pin 的 NSIS 3.04.1 里没有 MUI_UNHEADER_TEXT，卸载页同样用 MUI_HEADER_TEXT
    !insertmacro MUI_HEADER_TEXT "确认删除数据" "选择是否清除用户数据"
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}

    ${NSD_CreateLabel} 0 0 100% 24u "卸载程序将移除应用本体。下面的选项与此无关，勾选后会一并删除设置、播放记录与曲库数据库，且无法恢复。"
    Pop $0

    ${NSD_CreateCheckbox} 0 34u 100% 12u "同时删除用户数据"
    Pop $lpHDeleteData
    ${NSD_SetState} $lpHDeleteData ${BST_UNCHECKED}

    nsDialogs::Show
  FunctionEnd

  Function un.LpUserDataPageLeave
    ${NSD_GetState} $lpHDeleteData $1
    ${if} $1 == ${BST_CHECKED}
      StrCpy $lpDeleteUserData "1"
    ${else}
      StrCpy $lpDeleteUserData "0"
    ${endif}
  FunctionEnd

  # 卸载遍的自定义页用 UninstPage
  UninstPage custom un.LpUserDataPageCreate un.LpUserDataPageLeave
!macroend

# 页面被跳过时 leave 不执行，这里兜底读 --delete-app-data。
# ${GetParameters}/${GetOptions} 出自 FileFunc.nsh，由 multiUser.nsh 在更早的模板处引入。
# 注意别在这里写 ${if} ${isUpdated}：升级场景内置模板本来就会跳过卸载页流程。
!macro customUnInit
  StrCpy $lpDeleteUserData "0"

  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${ifNot} ${Errors}
    StrCpy $lpDeleteUserData "1"
  ${endIf}

  # 延迟回收模式（见 customRemoveFiles）：卸载时如果目录被杀软 / 资源管理器 /
  # 尚未退出干净的进程占用，卸载器自己删不掉，只能等它退出之后由这个副本来补。
  # 副本进程是卸载器自己的一份 temp 拷贝，带 --lp-cleanup 时只回收目录、不卸载。
  ${GetOptions} $R0 "--lp-cleanup" $lpCleanDir
  ${ifNot} ${Errors}
    ${if} $lpCleanDir != ""
      SetOutPath $TEMP
      Sleep 700
      RMDir "$lpCleanDir"
      Sleep 1500
      RMDir "$lpCleanDir"
      Sleep 3000
      RMDir "$lpCleanDir"
      Sleep 6000
      RMDir "$lpCleanDir"
      ${un.GetParent} "$lpCleanDir" $lpParent
      ${if} $lpParent != ""
        RMDir "$lpParent"
      ${endif}
      Delete "$TEMP\$EXEFILE"
      Abort
    ${endIf}
  ${endIf}
!macroend

# 内置模板只认 --delete-app-data，没有交互询问，所以这里自己删。
# 显式带参数时两边都会执行，RMDir /r 幂等，第二次是无操作。
!macro customUnInstall
  ${if} $lpDeleteUserData == "1"
    # Electron 的用户数据永远按当前用户存放，per-machine 卸载时 $APPDATA 要先切回当前用户
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend

# 覆盖 customRemoveFiles 必须补回模板原逻辑，
# 否则自动更新场景的原子改名/回滚会丢失。
!ifndef removeDefaultUninstallWelcomePage
  !macro customRemoveFiles
    ${if} ${isUpdated}
      CreateDirectory "$PLUGINSDIR\old-install"

      Push ""
      Call un.atomicRMDir
      Pop $R0

      ${if} $R0 != 0
        DetailPrint "File is busy, aborting: $R0"

        Push ""
        Call un.restoreFiles
        Pop $R0

        Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
      ${endif}
    ${endif}

    # 离开 $INSTDIR 才能删掉它
    SetOutPath $TEMP
    RMDir /r $INSTDIR

    # 下面的回收只在普通卸载里做。自动更新（${isUpdated}）时旧目录是被改名到
    # $PLUGINSDIR\old-install 的，新安装包紧接着会重建 $INSTDIR，
    # 这时候再来一次"空目录就删"会把刚建好的空安装目录删掉。
    ${ifNot} ${isUpdated}
      # RMDir /r 忽略失败：只要还有一个文件被占用，顶层目录就删不掉，卸载完留下一个空壳。
      # 就地再补一次不带 /r 的删除。
      Sleep 300
      RMDir $INSTDIR

      # 更新器缓存：下载过的安装包、差分源（installer.exe）、块索引。
      #
      # ⚠️ 这条必须切回 current 再删：electron-updater 用 process.env.LOCALAPPDATA
      #    + app.getName() 拼缓存目录，也就是「当前用户」的 AppData\Local；而 per-machine
      #    卸载时 initMultiUser 已经把 shell 变量上下文设成 all，此时 $LOCALAPPDATA
      #    指向 C:\ProgramData —— 删的是不存在的路径，静默无操作。与 customUnInstall
      #    里删 $APPDATA 的写法同理。
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
      !endif
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}

      # 占用往往要到本进程退出之后才消失，所以无条件再起一个副本进程接着试。
      ${un.GetParent} "$EXEPATH" $lpParent
      ${if} $lpParent != "$TEMP"
        CopyFiles "$EXEPATH" "$TEMP"
      ${endif}
      Exec `"$TEMP\$EXEFILE" /S --lp-cleanup "$INSTDIR"`

      # 装到 C:\ 这种根目录时 GetParent 返回空，跳过。
      ${un.GetParent} "$INSTDIR" $lpParent
      ${if} $lpParent != ""
        RMDir "$lpParent"
      ${endif}
    ${endif}
  !macroend
!endif
