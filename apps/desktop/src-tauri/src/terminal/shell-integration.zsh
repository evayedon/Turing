# Load the user's interactive configuration before adding our hooks.
if (( ${+_turing_user_zdotdir} )); then
    export ZDOTDIR="$_turing_user_zdotdir"
else
    unset ZDOTDIR
fi
unset _turing_user_zdotdir

if [[ -r "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
    builtin source "${ZDOTDIR:-$HOME}/.zshrc"
fi

_turing_command_running=0
_turing_preexec() {
    _turing_command_running=1
    builtin printf '\e]133;C\a'
}
_turing_precmd() {
    local result=$?
    if (( _turing_command_running )); then
        builtin printf '\e]133;D;%d\a' "$result"
        _turing_command_running=0
    fi
    builtin printf '\e]133;A\a'
    return 0
}

preexec_functions=(_turing_preexec "${preexec_functions[@]}")
precmd_functions=(_turing_precmd "${precmd_functions[@]}")
