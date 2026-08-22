export interface SkillCollision {
  resourceType: "skill";
  name: string;
  winnerPath: string;
  loserPath: string;
  winnerSource?: string;
  loserSource?: string;
}

export interface SkillDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
  collision?: SkillCollision;
}
