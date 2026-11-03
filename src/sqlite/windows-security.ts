import { spawnSync } from "node:child_process";
import type { ChainFolder } from "./windows-acl.js";

/** Windows PowerShell uses .NET Framework: this overload supplies the descriptor to mkdir. */
const PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Read-Folder([string] $path) {
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$path is a link or reparse point" }
  if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw "$path is not a directory" }
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
  $acl = [IO.Directory]::GetAccessControl($path, $sections)
  [PSCustomObject]@{
    path = $path
    ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    dacl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  }
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.mode -eq 'read') {
    $result = @(foreach ($path in $request.paths) { Read-Folder $path })
    ConvertTo-Json -InputObject $result -Compress
  } elseif ($request.mode -eq 'create') {
    foreach ($expected in $request.chain) {
      $actual = Read-Folder $expected.path
      if ($actual.ownerSid -ne $expected.ownerSid -or $actual.dacl -cne $expected.dacl) {
        throw 'the store folder ancestry changed during verification'
      }
    }
    foreach ($path in $request.paths) {
      if ([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)) {
        throw "$path already exists; a new Windows store requires a new folder"
      }
    }
    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetSecurityDescriptorSddlForm($request.sddl)
    foreach ($path in $request.paths) {
      [void][IO.Directory]::CreateDirectory($path, $security)
      $actual = Read-Folder $path
      $acl = [IO.Directory]::GetAccessControl($path)
      $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
      if ($actual.ownerSid -ne $request.ownerSid -or -not $acl.AreAccessRulesProtected -or $rules.Count -ne $request.accounts.Count) {
        throw "$path was not created private"
      }
      $seen = @{}
      foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($request.accounts -notcontains $sid -or $seen.ContainsKey($sid) -or
            $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
          throw "$path has unexpected access rules"
        }
        $seen[$sid] = $true
      }
    }
    [Console]::Write('true')
  } else { throw 'unknown security operation' }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function run(executable: string, request: unknown): unknown {
  const child = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(PROGRAM, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify(request),
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(
      `Windows store security failed: ${child.error?.message ?? child.stderr.trim()}; no store is created`,
    );
  }
  try {
    return JSON.parse(child.stdout.replace(/^\uFEFF/, ""));
  } catch (cause) {
    throw new Error("Windows store security returned invalid JSON; no store is created", { cause });
  }
}

/** No Get-Acl provider, compiled helper, or temporary file participates in these reads. */
export function readWindowsChain(executable: string, paths: readonly string[]): ChainFolder[] {
  const result = run(executable, { mode: "read", paths });
  if (!Array.isArray(result) || result.length !== paths.length) {
    throw new Error("Windows store security did not return the complete folder chain");
  }
  return result.map((value: unknown, index): ChainFolder => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      value.path !== paths[index] ||
      !("ownerSid" in value) ||
      typeof value.ownerSid !== "string" ||
      !("dacl" in value) ||
      typeof value.dacl !== "string"
    ) {
      throw new Error("Windows store security returned an invalid folder descriptor");
    }
    return {
      path: value.path,
      ownerSid: value.ownerSid,
      dacl: value.dacl,
      holdsStoreFolder: index === paths.length - 1,
    };
  });
}

/** Creates absent components with protected inheritable grants before they become visible. */
export function createWindowsFolders(
  executable: string,
  paths: readonly string[],
  chain: readonly ChainFolder[],
  ownerSid: string,
  accounts: readonly string[],
): void {
  const sddl = `O:${ownerSid}D:P${accounts.map((sid) => `(A;OICI;FA;;;${sid})`).join("")}`;
  if (run(executable, { mode: "create", paths, chain, ownerSid, accounts, sddl }) !== true) {
    throw new Error("Windows store security did not confirm private folder creation");
  }
}
