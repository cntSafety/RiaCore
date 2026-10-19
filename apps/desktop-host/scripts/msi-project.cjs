const fs = require('node:fs');
const path = require('node:path');

module.exports = async function msiProjectCreated(projectFile,
  licenseFile = path.join(__dirname, '../.release/licenses/RiaCore-LICENSE.txt')) {
  let xml = fs.readFileSync(projectFile, 'utf8');
  const replace = (pattern, replacement) => {
    if (!pattern.test(xml)) throw new Error('Unexpected MSI project structure');
    xml = xml.replace(pattern, replacement);
  };

  replace(/<Wix xmlns="http:\/\/wixtoolset.org\/schemas\/v4\/wxs">/,
    '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:util="http://wixtoolset.org/schemas/v4/wxs/util">');
  replace(/<Condition Message="Windows 7 and above is required">[\s\S]*?<\/Condition>/,
    `<Property Id="WINDOWS_BUILD">
      <RegistrySearch Id="WindowsBuild" Root="HKLM" Win64="yes"
        Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" Name="CurrentBuildNumber" Type="raw" />
    </Property>
    <Condition Message="Windows 10 or later is required"><![CDATA[Installed OR WINDOWS_BUILD >= 10240]]></Condition>`);
  // Keep removal inside the transaction so a failed upgrade restores the app.
  replace(/<MajorUpgrade /, '<MajorUpgrade Schedule="afterInstallInitialize" ');
  replace(/<Property Id="MSIINSTALLPERUSER"[^>]*\/>/, '');
  replace(/<\/Product>/, `
    <Property Id="MSIDISABLERMRESTART" Value="1" />
    <WixVariable Id="WixUILicenseRtf" Value="license.rtf" />
    <util:CloseApplication Id="CloseRiaCore" Target="RiaCore.exe"
      CloseMessage="yes" ElevatedCloseMessage="yes" Timeout="15"
      RebootPrompt="no" Property="RIACORE_RUNNING" />
  </Product>`);
  const license = fs.readFileSync(licenseFile, 'utf8')
    .replace(/[\\{}\u0080-\uffff]/g, char => {
      const code = char.charCodeAt(0);
      return code < 128 ? `\\${char}` : `\\u${code > 32767 ? code - 65536 : code}?`;
    })
    .replace(/\r?\n/g, '\\par\n');
  fs.writeFileSync(path.join(path.dirname(projectFile), 'license.rtf'), `{\\rtf1\\ansi\\fs18\n${license}\n}`);
  fs.writeFileSync(projectFile, xml);
};
