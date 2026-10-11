import { describe, expect, it } from "vitest";
import {
  InvalidWorkspacePathError,
  WorkspacePathOutsideBoundaryError,
} from "../../src/domain/errors.js";
import { sanitizeWorkspacePath } from "../../src/domain/workspace-path.js";

describe("Pure Lexical Path Sanitizer (Workspace Boundary)", () => {
  describe("Valid Safe Relative Paths", () => {
    it("accepts canonical POSIX relative paths", () => {
      const res = sanitizeWorkspacePath("src/main.ts");
      expect(res.rawPath).toBe("src/main.ts");
      expect(res.normalizedPath).toBe("src/main.ts");
      expect(res.segments).toEqual(["src", "main.ts"]);
      expect(Object.isFrozen(res)).toBe(true);
      expect(Object.isFrozen(res.segments)).toBe(true);
    });

    it("normalizes redundant current directory markers (./)", () => {
      const res = sanitizeWorkspacePath("./src/./components/./App.tsx");
      expect(res.normalizedPath).toBe("src/components/App.tsx");
      expect(res.segments).toEqual(["src", "components", "App.tsx"]);
    });

    it("normalizes Windows backslash separators to POSIX slashes", () => {
      const res = sanitizeWorkspacePath("src\\utils\\helpers.ts");
      expect(res.normalizedPath).toBe("src/utils/helpers.ts");
      expect(res.segments).toEqual(["src", "utils", "helpers.ts"]);
    });

    it("normalizes mixed slashes and backslashes", () => {
      const res = sanitizeWorkspacePath("src/lib\\core/index.ts");
      expect(res.normalizedPath).toBe("src/lib/core/index.ts");
    });

    it("resolves safe interior parent directory sequences without escaping root", () => {
      const res = sanitizeWorkspacePath("src/utils/../components/Button.tsx");
      expect(res.normalizedPath).toBe("src/components/Button.tsx");
      expect(res.segments).toEqual(["src", "components", "Button.tsx"]);
    });

    it("allows single file in workspace root", () => {
      const res = sanitizeWorkspacePath("README.md");
      expect(res.normalizedPath).toBe("README.md");
      expect(res.segments).toEqual(["README.md"]);
    });
  });

  describe("Directory Traversal Rejection (Escaping Root)", () => {
    it("rejects path starting with ../", () => {
      expect(() => sanitizeWorkspacePath("../secret")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects deep traversal ../../etc/passwd", () => {
      expect(() => sanitizeWorkspacePath("../../etc/passwd")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects interior traversal that pops above root", () => {
      expect(() => sanitizeWorkspacePath("foo/../../bar")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects multi-step traversal attempting boundary escape", () => {
      expect(() => sanitizeWorkspacePath("a/b/c/../../../../escape")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });
  });

  describe("Absolute & Platform Prefix Path Rejection", () => {
    it("rejects POSIX absolute paths starting with /", () => {
      expect(() => sanitizeWorkspacePath("/etc/passwd")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects Windows absolute paths starting with \\", () => {
      expect(() => sanitizeWorkspacePath("\\Windows\\System32")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects Windows drive letter paths with backslash (C:\\foo)", () => {
      expect(() => sanitizeWorkspacePath("C:\\Windows\\System32")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects Windows drive letter paths with slash (C:/foo)", () => {
      expect(() => sanitizeWorkspacePath("C:/data/project")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects drive-relative paths (C:foo)", () => {
      expect(() => sanitizeWorkspacePath("c:foo.txt")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects UNC network paths (//server/share)", () => {
      expect(() => sanitizeWorkspacePath("//192.168.1.1/shared")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });

    it("rejects UNC network paths with backslashes (\\\\server\\share)", () => {
      expect(() => sanitizeWorkspacePath("\\\\server\\share\\file")).toThrowError(
        WorkspacePathOutsideBoundaryError
      );
    });
  });

  describe("Null Byte & Injection Attack Rejection", () => {
    it("rejects literal null byte \\0 in path", () => {
      expect(() => sanitizeWorkspacePath("foo/bar\0.js")).toThrowError(
        InvalidWorkspacePathError
      );
    });

    it("rejects URL-encoded null byte %00 in path", () => {
      expect(() => sanitizeWorkspacePath("foo/bar%00.js")).toThrowError(
        InvalidWorkspacePathError
      );
    });

    it("rejects control characters", () => {
      expect(() => sanitizeWorkspacePath("foo/\x1b[31mred\x1b[0m.js")).toThrowError(
        InvalidWorkspacePathError
      );
      expect(() => sanitizeWorkspacePath("foo/\x07bell.txt")).toThrowError(
        InvalidWorkspacePathError
      );
    });
  });

  describe("Windows Reserved Device Name Rejection", () => {
    it("rejects CON, PRN, AUX, NUL device names", () => {
      expect(() => sanitizeWorkspacePath("CON")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("prn.txt")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("src/aux/file.ts")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("sub/NUL.log")).toThrowError(InvalidWorkspacePathError);
    });

    it("rejects COM1-9 and LPT1-9 device names", () => {
      expect(() => sanitizeWorkspacePath("com1")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("LPT3.txt")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("deep/com9.bin")).toThrowError(InvalidWorkspacePathError);
    });
  });

  describe("Dangerous & Illegal Character Rejection", () => {
    it("rejects NTFS Alternate Data Stream separator (:)", () => {
      expect(() => sanitizeWorkspacePath("file.txt:hidden_stream")).toThrowError(
        InvalidWorkspacePathError
      );
    });

    it("rejects shell redirection and wildcard characters (<, >, \", |, ?, *)", () => {
      expect(() => sanitizeWorkspacePath("file<1>.txt")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("file>output.txt")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("file\"quoted\".txt")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("file|pipe.txt")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("file?.txt")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("*.ts")).toThrowError(InvalidWorkspacePathError);
    });

    it("rejects trailing dot and trailing whitespace in segments", () => {
      expect(() => sanitizeWorkspacePath("src/file.")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("src/file ")).toThrowError(InvalidWorkspacePathError);
    });
  });

  describe("Empty & Malformed Path Handling", () => {
    it("rejects non-string values", () => {
      expect(() => sanitizeWorkspacePath(null)).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath(undefined)).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath(12345)).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath({})).toThrowError(InvalidWorkspacePathError);
    });

    it("rejects empty and whitespace-only strings", () => {
      expect(() => sanitizeWorkspacePath("")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("   ")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("\t\n")).toThrowError(InvalidWorkspacePathError);
    });
  });

  describe("Workspace Root (allowRoot) Behavior", () => {
    it("rejects paths resolving to workspace root when allowRoot is false (default)", () => {
      expect(() => sanitizeWorkspacePath(".")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("./.")).toThrowError(InvalidWorkspacePathError);
      expect(() => sanitizeWorkspacePath("foo/..")).toThrowError(InvalidWorkspacePathError);
    });

    it("permits paths resolving to workspace root when allowRoot is true", () => {
      const resDot = sanitizeWorkspacePath(".", { allowRoot: true });
      expect(resDot.normalizedPath).toBe(".");
      expect(resDot.segments).toEqual([]);

      const resSub = sanitizeWorkspacePath("foo/..", { allowRoot: true });
      expect(resSub.normalizedPath).toBe(".");
      expect(resSub.segments).toEqual([]);
    });
  });
});
