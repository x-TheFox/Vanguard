/**
 * File Management Tools — MCP tool implementations for server file operations
 *
 * Tools:
 * - list_files (Client API)
 * - read_file (Client API)
 * - write_file (Client API, max 5MB)
 * - upload_file (Client API, two-step)
 * - delete_files (Client API, gated)
 * - rename_files (Client API)
 * - create_folder (Client API)
 *
 * All file paths are sanitized via sanitizePath(). Protected paths are rejected.
 */

import { pteroClient } from '../httpClient.js';
import { checkPermissionGate } from '../safety/permissionGates.js';
import { sanitizePath, isProtectedPath } from '../safety/pathSanitizer.js';
import { redactSecrets, SAFETY } from '@edenvanguard/shared';

// ── Helpers ───────────────────────────────────────────────────

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

function handleError(error: unknown, toolName: string) {
  const msg = error instanceof Error ? error.message : String(error);
  return errorResult(`[${toolName}] ${redactSecrets(msg)}`);
}

/** Sanitize and validate a path, rejecting protected paths */
function validateFilePath(rawPath: string): string | null {
  try {
    const clean = sanitizePath(rawPath);
    if (isProtectedPath(clean)) {
      return null; // Signal protected path
    }
    return clean;
  } catch {
    return null;
  }
}

// ── list_files ────────────────────────────────────────────────

export interface ListFilesParams {
  server_id: string;
  directory?: string;
}

export async function listFiles(params: ListFilesParams) {
  try {
    const dir = sanitizePath(params.directory ?? '/');
    const response = await pteroClient.get(
      `/api/client/servers/${params.server_id}/files/list?directory=${encodeURIComponent(dir)}`,
      'list_files',
      params.server_id,
    );
    return toolResult(response.data);
  } catch (error: unknown) {
    return handleError(error, 'list_files');
  }
}

// ── read_file ─────────────────────────────────────────────────

export interface ReadFileParams {
  server_id: string;
  file_path: string;
}

export async function readFile(params: ReadFileParams) {
  try {
    const cleanPath = validateFilePath(params.file_path);
    if (cleanPath === null) {
      return errorResult('[read_file] Path is invalid or in a protected directory');
    }

    const response = await pteroClient.get(
      `/api/client/servers/${params.server_id}/files/contents?file=${encodeURIComponent(cleanPath)}`,
      'read_file',
      params.server_id,
    );
    return toolResult(response.data);
  } catch (error: unknown) {
    return handleError(error, 'read_file');
  }
}

// ── write_file ────────────────────────────────────────────────

export interface WriteFileParams {
  server_id: string;
  file_path: string;
  content: string;
}

export async function writeFile(params: WriteFileParams) {
  try {
    const cleanPath = validateFilePath(params.file_path);
    if (cleanPath === null) {
      return errorResult('[write_file] Path is invalid or in a protected directory');
    }

    // Validate content size (base64-encoded content)
    const contentBytes = Buffer.byteLength(params.content, 'utf8');
    if (contentBytes > SAFETY.MAX_WRITE_FILE_BYTES) {
      return errorResult(
        `[write_file] Content size (${contentBytes} bytes) exceeds maximum allowed (${SAFETY.MAX_WRITE_FILE_BYTES} bytes / 5MB)`,
      );
    }

    await pteroClient.post(
      `/api/client/servers/${params.server_id}/files/write?file=${encodeURIComponent(cleanPath)}`,
      params.content,
      'write_file',
      params.server_id,
    );

    return toolResult({ success: true, file_path: cleanPath });
  } catch (error: unknown) {
    return handleError(error, 'write_file');
  }
}

// ── upload_file ───────────────────────────────────────────────

export interface UploadFileParams {
  server_id: string;
  target_path: string;
  file_data_base64: string;
  file_size_bytes: number;
}

export async function uploadFile(params: UploadFileParams) {
  try {
    const cleanPath = sanitizePath(params.target_path);

    // Check protected path
    if (isProtectedPath(cleanPath)) {
      return errorResult('[upload_file] Cannot upload to a protected path');
    }

    // Step 1: Get signed upload URL from Pterodactyl
    const uploadUrlResponse = await pteroClient.get(
      `/api/client/servers/${params.server_id}/files/upload`,
      'upload_file',
      params.server_id,
    );

    const uploadData = uploadUrlResponse.data as { url: string };
    const signedUrl = uploadData.url;

    // Step 2: Decode base64 and PUT the file data to the signed URL
    const fileBuffer = Buffer.from(params.file_data_base64, 'base64');

    const putResponse = await fetch(signedUrl, {
      method: 'PUT',
      body: fileBuffer,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });

    if (!putResponse.ok) {
      return errorResult(
        `[upload_file] Upload PUT failed with status ${putResponse.status}: ${redactSecrets(await putResponse.text())}`,
      );
    }

    return toolResult({ success: true, target_path: cleanPath, size_bytes: params.file_size_bytes });
  } catch (error: unknown) {
    return handleError(error, 'upload_file');
  }
}

// ── delete_files ──────────────────────────────────────────────

export interface DeleteFilesParams {
  server_id: string;
  root?: string;
  files: string[];
  confirm?: boolean;
  [key: string]: unknown;
}

export async function deleteFiles(params: DeleteFilesParams) {
  try {
    // Check permission gate
    const gate = checkPermissionGate('delete_files', params as Record<string, unknown>);
    if (!gate.allowed) {
      return errorResult(gate.reason ?? 'Permission denied for delete_files');
    }

    const root = sanitizePath(params.root ?? '/');

    // Check for protected paths
    for (const file of params.files) {
      const fullPath = root === '/' ? `/${file}` : `${root}/${file}`;
      if (isProtectedPath(sanitizePath(fullPath))) {
        return errorResult(`[delete_files] Cannot delete protected path: ${fullPath}`);
      }
    }

    await pteroClient.post(
      `/api/client/servers/${params.server_id}/files/delete`,
      { root, files: params.files },
      'delete_files',
      params.server_id,
    );

    return toolResult({ success: true, deleted: params.files.length, root });
  } catch (error: unknown) {
    return handleError(error, 'delete_files');
  }
}

// ── rename_files ──────────────────────────────────────────────

export interface RenameFile {
  from: string;
  to: string;
}

export interface RenameFilesParams {
  server_id: string;
  root?: string;
  files: RenameFile[];
}

export async function renameFiles(params: RenameFilesParams) {
  try {
    const root = sanitizePath(params.root ?? '/');

    await pteroClient.post(
      `/api/client/servers/${params.server_id}/files/rename`,
      { root, files: params.files },
      'rename_files',
      params.server_id,
    );

    return toolResult({ success: true, renamed: params.files.length, root });
  } catch (error: unknown) {
    return handleError(error, 'rename_files');
  }
}

// ── create_folder ─────────────────────────────────────────────

export interface CreateFolderParams {
  server_id: string;
  path?: string;
  name: string;
}

export async function createFolder(params: CreateFolderParams) {
  try {
    const basePath = sanitizePath(params.path ?? '/');

    // Check protected path
    if (isProtectedPath(basePath)) {
      return errorResult('[create_folder] Cannot create folder in a protected path');
    }

    await pteroClient.post(
      `/api/client/servers/${params.server_id}/files/create-folder`,
      { root: basePath, name: params.name },
      'create_folder',
      params.server_id,
    );

    return toolResult({ success: true, path: basePath, name: params.name });
  } catch (error: unknown) {
    return handleError(error, 'create_folder');
  }
}
