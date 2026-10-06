### Install

1. Download the DMG for your Mac: **arm64** for Apple silicon (M1 and later), **x64** for Intel.
2. Open it and drag DataGrippe to Applications.
3. The app is not notarized by Apple, so macOS blocks its first launch. Run once in a terminal:

   ```sh
   xattr -dr com.apple.quarantine /Applications/DataGrippe.app
   ```

   or try to open it, then choose **Open Anyway** in System Settings › Privacy & Security.

After an update, macOS may ask again for the "DataGrippe Safe Storage" keychain item (saved passwords): choose
**Always Allow**. `SHA256SUMS.txt` lists the checksums of the DMGs.
