import fs from "node:fs";

const data = JSON.parse(fs.readFileSync("scratch/phase48p-repair-results.json", "utf8"));

console.log("Execution verified:", data.execution.verified);
console.log("Terminal status:", data.execution.terminalStatus);
console.log("Latch cleanRoomVerified:", data.execution.postPassLatchSnapshot.cleanRoomVerified);
console.log("Latch cleanRoomStatus:", data.execution.postPassLatchSnapshot.cleanRoomStatus);
console.log("Candidate matches gold:", data.stageProgression.stageB_mutation.candidateMatchesGold);
console.log("Final calc.js hash:", data.stageProgression.stageB_mutation.finalHash);
console.log("Gold hash:", data.stageProgression.stageB_mutation.goldHash);
console.log("Offline audit status:", data.stageProgression.stageD_evidence.offlineAuditStatus);
console.log("Replay derived outcome:", data.stageProgression.stageD_evidence.replayDerivedOutcome);
console.log("Fourfold predicates:", JSON.stringify(data.stageProgression.stageD_evidence.fourfoldPredicates, null, 2));
