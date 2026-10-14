class ForgeError(Exception):
    """Base class; the message is safe to show to users and to the AI."""


class PathError(ForgeError):
    pass


class ConflictError(ForgeError):
    def __init__(self, current_hash: str):
        super().__init__("The file changed since you opened it.")
        self.current_hash = current_hash


class EditError(ForgeError):
    pass
