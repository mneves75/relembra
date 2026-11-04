import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChainFolder } from "./windows-acl.js";

/**
 * Windows PowerShell uses .NET Framework: this overload supplies the descriptor to mkdir, and a
 * named mutex serialises the creators of one store, so two first opens both succeed.
 */
const PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
function Read-Folder([string] $path) {
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$path is a link or reparse point" }
  if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw "$path is not a directory" }
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
  $acl = [IO.Directory]::GetAccessControl($path, $sections)
  @{
    path = $path
    ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    dacl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  }
}
function Test-Entry([string] $path) {
  [IO.Directory]::Exists($path) -or [IO.File]::Exists($path)
}
# Exactly one full-control allow per account, nothing else: a folder's own entries, a file's
# inherited ones. A folder is owned by the user, whose SID its descriptor names; a file by the
# token's default owner, which is Administrators for an administrator, so any of the accounts.
function Confirm-Rules($acl, [string] $what, [string[]] $owners) {
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($owners -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -or $rules.Count -ne $request.accounts.Count) {
    throw "$what is not private"
  }
  $seen = @{}
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if ($request.accounts -notcontains $sid -or $seen.ContainsKey($sid) -or
        $rule.AccessControlType -ne 'Allow' -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {
      throw "$what has unexpected access rules"
    }
    $seen[$sid] = $true
  }
  $rules
}
function Confirm-Folder([string] $path) {
  [void](Read-Folder $path)
  $acl = [IO.Directory]::GetAccessControl($path)
  if (-not $acl.AreAccessRulesProtected) { throw "$path was not created private" }
  foreach ($rule in (Confirm-Rules $acl $path @($request.ownerSid))) {
    if ($rule.IsInherited -or
        $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
      throw "$path has unexpected access rules"
    }
  }
}
function Confirm-File([string] $path) {
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -ne 0) { throw "$path is not a regular file" }
  [void](Confirm-Rules ([IO.File]::GetAccessControl($path)) $path $request.accounts)
}
# The lock is ours only when its owner and every grant are: a squatted name is refused, never
# re-permissioned.
function Confirm-Lock($lock) {
  $acl = $lock.GetAccessControl()
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $request.ownerSid) { throw 'the store creation lock is owned by another account' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $request.accounts.Count) { throw 'the store creation lock grants another account access' }
  foreach ($rule in $rules) {
    if ($request.accounts -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne 'Allow' -or
        $rule.MutexRights -ne [System.Security.AccessControl.MutexRights]::FullControl) {
      throw 'the store creation lock grants another account access'
    }
  }
}
try {
  $request = $serializer.DeserializeObject([Console]::In.ReadToEnd())
  if ($request.mode -eq 'read') {
    $result = @(foreach ($path in $request.paths) { Read-Folder $path })
    [Console]::Write($serializer.Serialize([object[]]$result))
  } elseif ($request.mode -eq 'create') {
    if ($request.lockName -notmatch '^Global\\relembra-[0-9a-f]{64}$') { throw 'invalid store creation lock name' }
    $lockSecurity = [System.Security.AccessControl.MutexSecurity]::new()
    $lockSecurity.SetSecurityDescriptorSddlForm($request.lockSddl)
    $createdNew = $false
    $lock = [System.Threading.Mutex]::new($false, $request.lockName, [ref] $createdNew, $lockSecurity)
    $held = $false
    try {
      Confirm-Lock $lock
      try { $held = $lock.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
      if (-not $held) { throw 'another process is still creating the store folder' }
      if (Test-Entry $request.store) {
        # Another creator finished under this lock: its folder must be exactly what this one would
        # have made. An abandoned lock never adopts an unfinished folder: the store is absent then.
        Confirm-File $request.store
        Confirm-Folder $request.folder
        $result = 'exists'
      } else {
        foreach ($expected in $request.chain) {
          $actual = Read-Folder $expected.path
          if ($actual.ownerSid -ne $expected.ownerSid -or $actual.dacl -cne $expected.dacl) {
            throw 'the store folder ancestry changed during verification'
          }
        }
        foreach ($path in $request.paths) {
          if (Test-Entry $path) { throw "$path already exists; a new Windows store requires a new folder" }
        }
        foreach ($path in $request.paths) {
          # A fresh descriptor per call: Persist clears what a reused one would apply again.
          $security = [Security.AccessControl.DirectorySecurity]::new()
          $security.SetSecurityDescriptorSddlForm($request.sddl)
          [void][IO.Directory]::CreateDirectory($path, $security)
          Confirm-Folder $path
          # Files made in the folder carry its grants as inherited entries only under the
          # auto-inherit model (AI). Creation may hand the kernel a descriptor without it; setting
          # the same descriptor again goes through SetNamedSecurityInfo, which adopts the model.
          if (-not (Read-Folder $path).dacl.StartsWith('D:PAI')) {
            $again = [Security.AccessControl.DirectorySecurity]::new()
            $again.SetSecurityDescriptorSddlForm($request.sddl)
            [IO.Directory]::SetAccessControl($path, $again)
            Confirm-Folder $path
            if (-not (Read-Folder $path).dacl.StartsWith('D:PAI')) { throw "$path did not take the auto-inherit model" }
          }
        }
        foreach ($sidecar in $request.sidecars) {
          if (Test-Entry $sidecar) { throw "$sidecar exists without its store; no store is created beside it" }
        }
        [IO.FileStream]::new($request.store, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None).Dispose()
        Confirm-File $request.store
        $result = 'created'
      }
    } finally {
      if ($held) { $lock.ReleaseMutex() }
      $lock.Dispose()
    }
    [Console]::Write($serializer.Serialize($result))
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
    return JSON.parse(child.stdout.replace(/^﻿/, ""));
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

/**
 * The name of the mutex that serialises the creators of one store: one per account and store
 * folder, compared as Windows compares paths, without case. A long and a short (8.3) spelling
 * of one folder take two names, so two such creators refuse each other, never both create.
 */
export function storeLockName(ownerSid: string, folder: string): string {
  const digest = createHash("sha256").update(`${ownerSid}\n${folder.toLowerCase()}`).digest("hex");
  return `Global\\relembra-${digest}`;
}

/** The mutex's own descriptor: full control (0x1f0001) for the accounts, nothing else. */
export function storeLockSddl(ownerSid: string, accounts: readonly string[]): string {
  return `O:${ownerSid}D:P${accounts.map((sid) => `(A;;0x1f0001;;;${sid})`).join("")}`;
}

/**
 * The store folder's descriptor: protected, so nothing is inherited into it, and auto-inherited
 * (`AI`), so what is made in it carries its grants as inherited entries, as a folder set with
 * icacls does. Without `AI` Windows copies the grants into new files unmarked.
 */
export function storeFolderSddl(ownerSid: string, accounts: readonly string[]): string {
  return `O:${ownerSid}D:PAI${accounts.map((sid) => `(A;OICI;FA;;;${sid})`).join("")}`;
}

/**
 * Creates the absent folders with protected inheritable grants before they become visible, then
 * the empty store file in the last, all under the store's lock. Returns `exists` when another
 * creator finished the same store under that lock meanwhile.
 */
export function createStoreUnderLock(
  executable: string,
  store: string,
  folder: string,
  paths: readonly string[],
  chain: readonly ChainFolder[],
  ownerSid: string,
  accounts: readonly string[],
): "created" | "exists" {
  const result = run(executable, {
    mode: "create",
    store,
    folder,
    paths,
    sidecars: [`${store}-wal`, `${store}-shm`, `${store}-journal`],
    chain,
    ownerSid,
    accounts,
    sddl: storeFolderSddl(ownerSid, accounts),
    lockName: storeLockName(ownerSid, folder),
    lockSddl: storeLockSddl(ownerSid, accounts),
  });
  if (result !== "created" && result !== "exists") {
    throw new Error("Windows store security did not confirm private store creation");
  }
  return result;
}
