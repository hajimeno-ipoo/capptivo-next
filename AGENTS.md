# Capptivo のローカル配布ルール

- このプロジェクトの手元用配布は `.app` と DMG です。App Store、Developer ID、公証、自動更新用の署名を勝手に追加しません。
- ビルド元のアプリは `src-tauri/target/release/bundle/macos/Capptivo.app`、配布DMGは `src-tauri/target/release/bundle/dmg/Capptivo_1.0.3_aarch64.dmg` に置きます。DMGは Tauri の `bundle_dmg.sh` で作ります。スクリプトには、生成した `Capptivo.app` だけをコピーした一時フォルダを入力します。`bundle/macos` 全体を入力してはいけません。そこにある旧版アプリや自動更新用ファイルまでDMGへ入るためです。
- `/Applications` には利用する `/Applications/Capptivo.app` だけを置きます。更新時に旧版のバックアップや退避コピーを作りません。DMG作成に必要な新しい `.app` の一時作業用コピーも、検証後に削除します。
- アプリの入れ替えには `/usr/bin/ditto --rsrc --extattr` を使います。入れ替え後、ビルド元・DMG内・`/Applications` のアプリの内容と署名をそれぞれ検査します。DMG直下には `Capptivo.app` と `Applications` リンクだけがあり、旧版アプリや圧縮ファイルがないことを確認します。DMGの整合性と `/Applications` に Capptivo が１件だけであることも確認します。
- macOS の画面収録権限、システム設定内のアイコン、実画面の動作は、ビルドや署名の検査だけで合格と報告しません。権限がなく実画面を確認できない場合は未確認と明記します。
