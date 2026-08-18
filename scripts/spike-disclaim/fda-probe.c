/*
 * Spike 2 — does `responsibility_spawnattrs_setdisclaim` give this binary its
 * own TCC identity?
 *
 * Background. macOS attributes a process's file access to its *responsible
 * process*, which is normally the app bundle at the top of the launch chain.
 * For an MCP server that is Visual Studio Code, so granting Full Disk Access
 * would mean granting it to the whole editor.
 *
 * `responsibility_spawnattrs_setdisclaim` (private, but stable since 10.14)
 * makes a spawned child its own responsible process. The subtlety this probe
 * exists to settle: disclaim applies to the CHILD, and the obvious child is
 * `node` — which would just move the grant onto Homebrew's node, shared by
 * every node process on the machine. So we re-exec *ourselves* disclaimed, and
 * then check whether a node grandchild inherits *us* as its responsible
 * process. Only if BOTH reads succeed can this binary front the real server.
 *
 * Build + sign:  make -C scripts/spike-disclaim
 * Run:           ./scripts/spike-disclaim/fda-probe
 */

#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef int (*disclaim_fn)(posix_spawnattr_t *, int);

/* Read, not stat: stat SUCCEEDS on a TCC-protected file and only open(2) is
 * denied, so stat would report success and prove nothing. */
static int can_read(const char *path) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return 0;
  char buf[16];
  ssize_t n = read(fd, buf, sizeof buf);
  close(fd);
  return n > 0;
}

static void index_path(char *out, size_t len) {
  const char *home = getenv("HOME");
  snprintf(out, len, "%s/Library/Mail/V10/MailData/Envelope Index", home ? home : "");
}

/* Spawn a node grandchild that attempts the same read. If disclaim attributed
 * responsibility to us, the grandchild inherits it and should also succeed. */
static int node_child_can_read(const char *path) {
  char script[1024];
  snprintf(script, sizeof script,
           "try{const fs=require('node:fs');fs.accessSync(process.argv[1],fs.constants.R_OK);"
           "process.exit(0)}catch(e){process.exit(3)}");

  char *argv[] = {"/usr/bin/env", "node", "-e", script, (char *)path, NULL};
  pid_t pid;
  if (posix_spawn(&pid, "/usr/bin/env", NULL, NULL, argv, environ) != 0) return -1;

  int status = 0;
  if (waitpid(pid, &status, 0) < 0) return -1;
  if (!WIFEXITED(status)) return -1;
  int code = WEXITSTATUS(status);
  if (code == 0) return 1;
  if (code == 3) return 0;
  return -1; /* node missing or failed for an unrelated reason */
}

static int run_inner(void) {
  char path[1024];
  index_path(path, sizeof path);

  int self = can_read(path);
  int child = node_child_can_read(path);

  printf("  inner (this binary)   : %s\n", self ? "READABLE" : "denied");
  printf("  inner -> node child   : %s\n",
         child == 1 ? "READABLE" : child == 0 ? "denied" : "could not run node");

  if (self && child == 1) {
    printf("\nRESULT: PASS - disclaim attributes to this binary, and a node child inherits it.\n");
    printf("        Route C is viable: the wrapper can front the real server.\n");
    return 0;
  }
  if (self && child != 1) {
    printf("\nRESULT: PARTIAL - this binary can read, but its node child cannot.\n");
    printf("        Route C cannot front `node dist/cli.js` as designed.\n");
    return 1;
  }
  printf("\nRESULT: FAIL - still denied. Either FDA was not granted to this binary,\n");
  printf("        or disclaim did not move the responsible process.\n");
  return 1;
}

int main(int argc, char **argv) {
  char path[1024];
  index_path(path, sizeof path);

  if (argc > 1 && strcmp(argv[1], "--inner") == 0) return run_inner();

  printf("FDA disclaim probe\n");
  printf("  target: %s\n\n", path);

  /* Baseline: what do we get WITHOUT disclaim, i.e. attributed to whatever
   * launched us (VS Code, Terminal...)? */
  printf("  outer (no disclaim)   : %s\n", can_read(path) ? "READABLE" : "denied");

  /* Resolve the symbol at runtime. It is private, so linking it directly would
   * turn a future removal into a build failure instead of a clear message. */
  disclaim_fn set_disclaim = (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (!set_disclaim) {
    printf("\nRESULT: FAIL - responsibility_spawnattrs_setdisclaim is not available.\n");
    printf("        Route C is dead on this macOS version.\n");
    return 1;
  }
  printf("  disclaim symbol       : found\n\n");

  posix_spawnattr_t attrs;
  if (posix_spawnattr_init(&attrs) != 0) {
    fprintf(stderr, "posix_spawnattr_init failed\n");
    return 1;
  }
  if (set_disclaim(&attrs, 1) != 0) {
    fprintf(stderr, "setdisclaim failed\n");
    return 1;
  }

  char self[1024];
  uint32_t size = sizeof self;
  if (_NSGetExecutablePath(self, &size) != 0) {
    fprintf(stderr, "could not resolve own path\n");
    return 1;
  }

  char *child_argv[] = {self, "--inner", NULL};
  pid_t pid;
  int rc = posix_spawn(&pid, self, NULL, &attrs, child_argv, environ);
  posix_spawnattr_destroy(&attrs);
  if (rc != 0) {
    fprintf(stderr, "posix_spawn failed: %s\n", strerror(rc));
    return 1;
  }

  int status = 0;
  waitpid(pid, &status, 0);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
