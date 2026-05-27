/**
 * TeamMemberCache
 *
 * Fetches the full Dropbox Business team member list at startup and caches
 * email → team_member_id mappings in memory. Refreshes every hour so new
 * hires and deactivated accounts stay in sync without a container restart.
 *
 * Used by the MCP request handler to map a Google-authenticated user's email
 * to the Dropbox-API-Select-User value for their request.
 */

import { DropboxClient } from "./dropbox-client.js";
import { logger } from "./logger.js";

interface TeamMemberListResult {
  members: Array<{
    profile: {
      team_member_id: string;
      email: string;
      status: { ".tag": string };
    };
  }>;
  has_more: boolean;
  cursor: string;
}

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class TeamMemberCache {
  private cache = new Map<string, string>(); // email → team_member_id
  private initialized = false;

  async init(adminClient: DropboxClient): Promise<void> {
    await this.refresh(adminClient);
    this.initialized = true;

    // Refresh hourly so new hires / deactivations are picked up
    setInterval(() => {
      this.refresh(adminClient).catch((err) =>
        logger.error("Team member cache refresh failed", { reason: String(err) })
      );
    }, REFRESH_INTERVAL_MS);
  }

  /**
   * Look up a user's Dropbox team_member_id by email.
   * Returns undefined if the user is not an active Dropbox team member.
   */
  lookup(email: string): string | undefined {
    return this.cache.get(email.toLowerCase());
  }

  get size(): number {
    return this.cache.size;
  }

  get ready(): boolean {
    return this.initialized;
  }

  private async refresh(adminClient: DropboxClient): Promise<void> {
    const next = new Map<string, string>();
    let cursor: string | undefined;

    do {
      const result: TeamMemberListResult = cursor
        ? await adminClient.callApi("/team/members/list/continue_v2", { cursor })
        : await adminClient.callApi("/team/members/list_v2", { limit: 300 });

      for (const member of result.members) {
        // Only cache active members — suspended/removed users should not be able to act
        if (member.profile.status[".tag"] === "active") {
          next.set(member.profile.email.toLowerCase(), member.profile.team_member_id);
        }
      }

      cursor = result.has_more ? result.cursor : undefined;
    } while (cursor);

    this.cache = next;
    logger.info("Team member cache refreshed", { activeMembers: this.cache.size });
  }
}
