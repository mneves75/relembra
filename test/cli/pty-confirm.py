"""Runs a command on a pseudo-terminal and answers relembra's owner-confirmation prompts.

    python3 pty-confirm.py [--between JSON] [--each] ANSWERS <command> [args...]

The child gets the terminal as its controlling tty. ANSWERS is a comma list of "right" or
"wrong", one per prompt in order: each time a "Type <CODE> to confirm" appears, this types the
code ("right") or a different one ("wrong"). A prompt beyond the list is left unanswered.

--between takes a JSON array, a command run to completion after a prompt appears and before it
is answered: the first prompt only, or every prompt with --each. It stands for a second process
writing to the store while a person reads the prompt.

Everything the child wrote is printed, and this exits with the child's exit code.
"""

import json
import os
import pty
import re
import select
import subprocess
import sys
import time

args = sys.argv[1:]
between = None
each = False
while args[0].startswith("--"):
    flag = args.pop(0)
    if flag == "--between":
        between = json.loads(args.pop(0))
    elif flag == "--each":
        each = True
    else:
        sys.exit(f"pty-confirm: unknown flag {flag}")
answers, *command = args
answers = answers.split(",")

pid, fd = pty.fork()
if pid == 0:
    os.execv(command[0], command)

PROMPT = re.compile(rb"Type ([A-Z0-9]{6}) to confirm")
output = b""
answered = 0
deadline = time.time() + 25
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    prompts = PROMPT.findall(output)
    if answered < len(prompts) and answered < len(answers):
        if between is not None and (each or answered == 0):
            subprocess.run(between, check=True, stdout=subprocess.DEVNULL)
        code = prompts[answered] if answers[answered] == "right" else b"WRONG0"
        os.write(fd, code + b"\n")
        answered += 1

_, status = os.waitpid(pid, 0)
sys.stdout.write(output.decode("utf-8", errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status))
