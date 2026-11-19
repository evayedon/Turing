# Load the user's .zshenv with the original ZDOTDIR. Keep this temporary
# directory active only until our .zshrc can load their configuration.
_turing_startup_dir=$ZDOTDIR
if (( ${+TURING_ZSH_USER_ZDOTDIR} )); then
    export ZDOTDIR="$TURING_ZSH_USER_ZDOTDIR"
else
    unset ZDOTDIR
fi
unset TURING_ZSH_USER_ZDOTDIR

if [[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]]; then
    builtin source "${ZDOTDIR:-$HOME}/.zshenv"
fi

if (( ${+ZDOTDIR} )); then
    _turing_user_zdotdir=$ZDOTDIR
fi
export ZDOTDIR="$_turing_startup_dir"
unset _turing_startup_dir
