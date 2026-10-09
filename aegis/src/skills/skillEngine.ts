/**
 * Skill Engine — Aegis Dynamic Skill Lifecycle Manager
 *
 * Manages the full lifecycle of skill files: discovery, parsing,
 * validation, registration, execution, and persistence.
 *
 * Skill files use YAML frontmatter followed by a JavaScript body:
 *   ---
 *   name: my-skill
 *   description: Does something useful
 *   version: 1.0.0
 *   author: aegis
 *   triggers:
 *     - event_name
 *   tools:
 *     - list_files
 *     - read_file
 *   ---
 *   // JavaScript body
 *   const result = await mcp.invoke('list_files', { ... });
 *   return result;
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { db } from '../db/client.js';
import { skillRegistry } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { mcpClient } from '../mcp/clientManager.js';
import { runSkillScript, type SkillContext } from './skillRunner.js';

// ── Types ──────────────────────────────────────────────────────

export interface SkillFile {
  name: string;
  description: string;
  version: string;
  author: string;
  triggers: string[];
  tools: string[];
  body: string;
  filePath: string;
}

interface FrontmatterFields {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  triggers?: string[];
  tools?: string[];
}

// ── Constants ──────────────────────────────────────────────────

const DEFAULT_SKILLS_DIR = join(process.cwd(), 'skills');
const SKILL_FILE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// ── Skill Engine ───────────────────────────────────────────────

export class SkillEngine {
  private skills = new Map<string, SkillFile>();
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? DEFAULT_SKILLS_DIR;
  }

  /** Discover and load all skill files from the skills directory */
  async loadAll(): Promise<void> {
    this.skills.clear();

    let entries: string[];
    try {
      entries = await readdir(this.skillsDir);
    } catch {
      // Directory doesn't exist yet — create it and return
      await mkdir(this.skillsDir, { recursive: true });
      return;
    }

    for (const entry of entries) {
      const ext = extname(entry);
      if (!SKILL_FILE_EXTENSIONS.has(ext)) continue;

      const filePath = join(this.skillsDir, entry);
      try {
        const content = await readFile(filePath, 'utf-8');
        const skill = this.parseSkillFile(filePath, content);

        if (!this.validateSkillTools(skill)) {
          console.error(
            `Skill "${skill.name}" references unavailable tools: ${skill.tools.join(', ')}. Skipping.`,
          );
          continue;
        }

        this.skills.set(skill.name, skill);

        // Upsert into skill_registry table
        await this.upsertSkillRegistry(skill);
      } catch (error) {
        console.error(`Failed to load skill file ${filePath}:`, error);
      }
    }

    console.error(`Skill engine loaded ${this.skills.size} skill(s)`);
  }

  /** Parse a skill file with YAML frontmatter */
  private parseSkillFile(filePath: string, content: string): SkillFile {
    // YAML frontmatter is delimited by `---` on its own line
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match || !match[1] || !match[2]) {
      throw new Error(
        `Skill file ${filePath} does not contain valid YAML frontmatter. ` +
        `Expected format: ---\\n<yaml>\\n---\\n<script>`,
      );
    }

    const yamlStr = match[1];
    const body = match[2];

    let fields: FrontmatterFields;
    try {
      fields = parseYaml(yamlStr) as FrontmatterFields;
    } catch {
      throw new Error(`Skill file ${filePath} contains invalid YAML frontmatter`);
    }

    if (!fields.name || typeof fields.name !== 'string') {
      throw new Error(`Skill file ${filePath} missing required "name" in frontmatter`);
    }
    if (!fields.description || typeof fields.description !== 'string') {
      throw new Error(`Skill file ${filePath} missing required "description" in frontmatter`);
    }

    return {
      name: fields.name,
      description: fields.description,
      version: fields.version ?? '1.0.0',
      author: fields.author ?? 'aegis',
      triggers: Array.isArray(fields.triggers) ? fields.triggers : [],
      tools: Array.isArray(fields.tools) ? fields.tools : [],
      body: body.trim(),
      filePath,
    };
  }

  /** Validate that a skill's tool references exist in the MCP registry */
  private validateSkillTools(skill: SkillFile): boolean {
    if (skill.tools.length === 0) return true; // No tool deps = always valid

    const availableTools = mcpClient.listAvailableTools();
    const missingTools = skill.tools.filter((t) => !availableTools.includes(t));

    if (missingTools.length > 0) {
      console.error(
        `Skill "${skill.name}" references unavailable tools: ${missingTools.join(', ')}`,
      );
      // Allow loading even with unavailable tools — they may become available later
      // Return true but log the warning. Skills that reference unavailable tools
      // will fail at execution time with a clear error.
      return true;
    }

    return true;
  }

  /** Execute a skill by name with given arguments */
  async execute(skillName: string, args: Record<string, unknown>): Promise<unknown> {
    const skill = this.skills.get(skillName);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Build the skill execution context
    const context: SkillContext = {
      args,
      mcp: {
        invoke: async (toolName: string, params: Record<string, unknown>) => {
          return mcpClient.invoke(toolName, params);
        },
        listTools: () => mcpClient.listAvailableTools(),
        isToolAvailable: (toolName: string) => mcpClient.isToolAvailable(toolName),
      },
      logger: {
        info: (message: string) => console.error(`[skill:${skillName}] INFO: ${message}`),
        warn: (message: string) => console.error(`[skill:${skillName}] WARN: ${message}`),
        error: (message: string) => console.error(`[skill:${skillName}] ERROR: ${message}`),
      },
    };

    try {
      const result = await runSkillScript(skill.body, context);

      // Update execution tracking in skill_registry
      await this.recordInvocation(skillName);

      return result;
    } catch (error) {
      console.error(`Skill "${skillName}" execution failed:`, error);
      throw error;
    }
  }

  /** Find skills matching a trigger */
  findByTrigger(trigger: string): SkillFile[] {
    const matches: SkillFile[] = [];
    for (const skill of this.skills.values()) {
      if (skill.triggers.includes(trigger)) {
        matches.push(skill);
      }
    }
    return matches;
  }

  /** Create a new skill file from Aegis-generated content */
  async createSkill(
    name: string,
    description: string,
    body: string,
    triggers: string[] = [],
    tools: string[] = [],
  ): Promise<string> {
    // Build YAML frontmatter
    const frontmatter = {
      name,
      description,
      version: '1.0.0',
      author: 'aegis',
      triggers,
      tools,
    };

    // Serialize YAML manually for deterministic output
    const yamlLines: string[] = [];
    yamlLines.push(`name: ${frontmatter.name}`);
    yamlLines.push(`description: ${frontmatter.description}`);
    yamlLines.push(`version: ${frontmatter.version}`);
    yamlLines.push(`author: ${frontmatter.author}`);

    if (triggers.length > 0) {
      yamlLines.push('triggers:');
      for (const t of triggers) {
        yamlLines.push(`  - ${t}`);
      }
    } else {
      yamlLines.push('triggers: []');
    }

    if (tools.length > 0) {
      yamlLines.push('tools:');
      for (const t of tools) {
        yamlLines.push(`  - ${t}`);
      }
    } else {
      yamlLines.push('tools: []');
    }

    const fileContent = `---\n${yamlLines.join('\n')}\n---\n${body}\n`;

    // Ensure directory exists
    await mkdir(this.skillsDir, { recursive: true });

    // Sanitize name for file path (replace non-alphanumeric chars with hyphens)
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
    const filePath = join(this.skillsDir, `${safeName}.js`);

    await writeFile(filePath, fileContent, 'utf-8');

    // Parse and register the new skill
    const skill = this.parseSkillFile(filePath, fileContent);
    this.skills.set(skill.name, skill);

    // Persist to database
    await this.upsertSkillRegistry(skill);

    return filePath;
  }

  /** List all loaded skills */
  listSkills(): SkillFile[] {
    return [...this.skills.values()];
  }

  /** Get a skill by name */
  getSkill(name: string): SkillFile | undefined {
    return this.skills.get(name);
  }

  /** Reload all skills (useful for hot-reload) */
  async reload(): Promise<void> {
    await this.loadAll();
  }

  // ── Private: Database Operations ────────────────────────────

  /** Insert or update skill in the skill_registry table */
  private async upsertSkillRegistry(skill: SkillFile): Promise<void> {
    try {
      // Check if skill already exists
      const existing = await db
        .select({ skillId: skillRegistry.skillId })
        .from(skillRegistry)
        .where(eq(skillRegistry.name, skill.name))
        .limit(1);

      if (existing.length > 0) {
        // Update existing record
        await db
          .update(skillRegistry)
          .set({
            description: skill.description,
            filePath: skill.filePath,
            version: skill.version,
            author: skill.author,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(skillRegistry.name, skill.name));
      } else {
        // Insert new record
        await db.insert(skillRegistry).values({
          name: skill.name,
          description: skill.description,
          language: 'javascript',
          filePath: skill.filePath,
          version: skill.version,
          author: skill.author,
          parameters: skill.tools as unknown as Record<string, unknown>[],
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Failed to upsert skill "${skill.name}" in registry:`, error);
    }
  }

  /** Record a skill invocation in the registry */
  private async recordInvocation(skillName: string): Promise<void> {
    try {
      await db
        .update(skillRegistry)
        .set({
          invocationCount: sql`${skillRegistry.invocationCount} + 1`,
          lastInvokedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(skillRegistry.name, skillName));
    } catch (error) {
      console.error(`Failed to record invocation for skill "${skillName}":`, error);
    }
  }
}

// Need to import sql for the increment expression
import { sql } from 'drizzle-orm';

/** Singleton skill engine instance */
export const skillEngine = new SkillEngine();
