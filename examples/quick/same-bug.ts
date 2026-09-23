import { semantic } from "jevascript"
import "../_setup.ts"

const open = "Login button does nothing on Safari"
const incoming = "Can't sign in from my Mac, clicking submit has no effect"

const duplicate = await semantic({ open, incoming }).is("These two reports describe the same underlying bug.")

console.log(duplicate ? "duplicate — link to the open report" : "new bug — create a report")
