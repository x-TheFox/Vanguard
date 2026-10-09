/**
 * Schedule Tools — MCP tool implementations for schedule management
 *
 * Tools:
 * - list_schedules (Client API)
 * - create_schedule (Client API)
 */

import { pteroClient } from '../httpClient.js';
import { redactSecrets } from '@edenvanguard/shared';

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

// ── list_schedules ────────────────────────────────────────────

export interface ListSchedulesParams {
  server_id: string;
}

export async function listSchedules(params: ListSchedulesParams) {
  try {
    const response = await pteroClient.get(
      `/api/client/servers/${params.server_id}/schedules`,
      'list_schedules',
      params.server_id,
    );
    return toolResult(response.data);
  } catch (error: unknown) {
    return handleError(error, 'list_schedules');
  }
}

// ── create_schedule ───────────────────────────────────────────

export interface ScheduleTask {
  action: 'command' | 'power' | 'backup';
  payload: string;
  time_offset?: number;
  continue_on_failure?: boolean;
}

export interface CreateScheduleParams {
  server_id: string;
  name: string;
  minute: string;
  hour: string;
  day_of_week?: string;
  day_of_month?: string;
  active?: boolean;
  only_when_online?: boolean;
  tasks: ScheduleTask[];
}

export async function createSchedule(params: CreateScheduleParams) {
  try {
    const body: Record<string, unknown> = {
      name: params.name,
      minute: params.minute,
      hour: params.hour,
      day_of_week: params.day_of_week ?? '*',
      day_of_month: params.day_of_month ?? '*',
      active: params.active ?? true,
      only_when_online: params.only_when_online ?? false,
    };

    // Create the schedule first
    const createResponse = await pteroClient.post(
      `/api/client/servers/${params.server_id}/schedules`,
      body,
      'create_schedule',
      params.server_id,
    );

    const scheduleData = createResponse.data as {
      attributes: {
        id: number;
        [key: string]: unknown;
      };
    };

    const scheduleId = scheduleData.attributes.id;

    // Add tasks to the schedule if provided
    if (params.tasks && params.tasks.length > 0) {
      for (const task of params.tasks) {
        const taskBody: Record<string, unknown> = {
          action: task.action,
          payload: task.payload,
          time_offset: task.time_offset ?? 0,
          continue_on_failure: task.continue_on_failure ?? false,
        };

        await pteroClient.post(
          `/api/client/servers/${params.server_id}/schedules/${scheduleId}/tasks`,
          taskBody,
          'create_schedule',
          params.server_id,
        );
      }
    }

    return toolResult({
      success: true,
      schedule_id: scheduleId,
      name: params.name,
      tasks_count: params.tasks?.length ?? 0,
    });
  } catch (error: unknown) {
    return handleError(error, 'create_schedule');
  }
}
