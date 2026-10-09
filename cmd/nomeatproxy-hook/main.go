// The native client transports hook JSON to the existing engine. It contains no policy shortcuts.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const maxInput = 128 * 1024
const maxReply = 256 * 1024

type request struct {
	Version   int    `json:"version"`
	Agent     string `json:"agent"`
	Cwd       string `json:"cwd"`
	Workspace string `json:"workspace,omitempty"`
	Input     string `json:"input"`
}

type hookResult struct {
	ExitCode *int    `json:"exitCode"`
	Stdout   *string `json:"stdout"`
	Stderr   *string `json:"stderr"`
}

type reply struct {
	Version int         `json:"version"`
	Result  *hookResult `json:"result"`
	Error   string      `json:"error"`
}

func validResult(agent string, result *hookResult) bool {
	if result == nil || result.ExitCode == nil || result.Stdout == nil || result.Stderr == nil {
		return false
	}
	if *result.ExitCode == 0 && *result.Stdout == "" && *result.Stderr == "" {
		return true
	}
	if agent == "generic" {
		return *result.ExitCode == 2 && *result.Stdout == "" && *result.Stderr != ""
	}
	if *result.ExitCode != 0 || *result.Stderr != "" {
		return false
	}
	var decision struct {
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
		Hook     *struct {
			Event    string `json:"hookEventName"`
			Decision string `json:"permissionDecision"`
			Reason   string `json:"permissionDecisionReason"`
		} `json:"hookSpecificOutput"`
	}
	if json.Unmarshal([]byte(*result.Stdout), &decision) != nil {
		return false
	}
	if agent == "antigravity" {
		return decision.Decision == "deny" && decision.Reason != ""
	}
	return decision.Hook != nil && decision.Hook.Event == "PreToolUse" &&
		decision.Hook.Decision == "deny" && decision.Hook.Reason != ""
}

func deny(agent, reason string) int {
	reason = "NoMeatProxy could not complete the safety check: " + reason + ". Restore the checker before retrying."
	var output any
	switch agent {
	case "antigravity":
		output = map[string]any{"decision": "deny", "reason": reason}
	case "claude", "codex":
		output = map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason,
		}}
	default:
		fmt.Fprintln(os.Stderr, reason)
		return 2
	}
	_ = json.NewEncoder(os.Stdout).Encode(output)
	return 0
}

func privatePath(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || info.Mode().Perm()&0077 != 0 ||
		info.Mode()&os.ModeSymlink != 0 {
		return errors.New("socket and parent must be private and owned by this user")
	}
	if directory && !info.IsDir() {
		return errors.New("socket parent is not a directory")
	}
	if !directory && info.Mode()&os.ModeSocket == 0 {
		return errors.New("checker endpoint is not a socket")
	}
	return nil
}

func execute() int {
	flags := flag.NewFlagSet("nomeatproxy-hook", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	agent := flags.String("agent", "generic", "claude, codex, antigravity, or generic")
	socket := flags.String("socket", "", "absolute Unix socket path")
	workspace := flags.String("workspace", "", "fixed workspace boundary")
	deadline := flags.Int("timeout-ms", 2000, "total transport deadline")
	if err := flags.Parse(os.Args[1:]); err != nil || flags.NArg() != 0 {
		return deny(*agent, "invalid launcher arguments")
	}
	if *agent != "claude" && *agent != "codex" && *agent != "antigravity" && *agent != "generic" {
		return deny("generic", "unknown agent")
	}
	if *deadline < 1 || *deadline > 4000 {
		return deny(*agent, "timeout must be between 1 and 4000 milliseconds")
	}
	if *socket == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return deny(*agent, "cannot resolve runtime directory")
		}
		*socket = filepath.Join(home, ".nomeatproxy", "run", "guard.sock")
	}
	if !filepath.IsAbs(*socket) || (*workspace != "" && !filepath.IsAbs(*workspace)) {
		return deny(*agent, "socket and workspace paths must be absolute")
	}
	if err := privatePath(filepath.Dir(*socket), true); err != nil {
		return deny(*agent, "unavailable or insecure socket directory")
	}
	if err := privatePath(*socket, false); err != nil {
		return deny(*agent, "unavailable or insecure checker socket")
	}
	input, err := io.ReadAll(io.LimitReader(os.Stdin, maxInput+1))
	if err != nil || len(input) > maxInput {
		return deny(*agent, "invalid or oversized hook input")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return deny(*agent, "cannot resolve working directory")
	}
	end := time.Now().Add(time.Duration(*deadline) * time.Millisecond)
	conn, err := net.DialTimeout("unix", *socket, time.Until(end))
	if err != nil {
		return deny(*agent, "checker is unavailable")
	}
	defer conn.Close()
	if err := conn.SetDeadline(end); err != nil {
		return deny(*agent, "cannot set transport deadline")
	}
	if err := json.NewEncoder(conn).Encode(request{1, *agent, cwd, *workspace, string(input)}); err != nil {
		return deny(*agent, "request could not be delivered")
	}
	reader := bufio.NewReader(io.LimitReader(conn, maxReply+1))
	line, err := reader.ReadBytes('\n')
	if err != nil || len(line) > maxReply {
		return deny(*agent, "checker timed out or returned an invalid response")
	}
	var response reply
	if err := json.Unmarshal(line, &response); err != nil || response.Version != 1 ||
		response.Error != "" || !validResult(*agent, response.Result) {
		return deny(*agent, "unsupported or invalid checker response")
	}
	fmt.Fprint(os.Stdout, *response.Result.Stdout)
	fmt.Fprint(os.Stderr, *response.Result.Stderr)
	return *response.Result.ExitCode
}

func main() {
	os.Exit(execute())
}
