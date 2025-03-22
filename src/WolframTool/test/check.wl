(* When running WolframScript from the command line, you need to use Print statements to display intermediate results *)

(* Define the spinor eigenstates *)
uPlus = {Cos[θ[k]/2], -I Sin[θ[k]/2]};
uMinus = {Sin[θ[k]/2], -I Cos[θ[k]/2]};

(* Define the Pauli matrix sigma_y *)
sigmaY = {{0, -I}, {I, 0}};

(* Compute the matrix element *)
matrixElement = ConjugateTranspose[uPlus].sigmaY.uMinus // FullSimplify;
Print["Matrix Element: ", matrixElement];

(* Compare with the expected result *)
expectedResult = (I/2) (1 - Cos[θ[k]] - Sin[θ[k]]);
Print["Expected Result: ", expectedResult];

(* Verify if they match *)
verification = Simplify[matrixElement == expectedResult];
Print["Verification Expression: ", verification];

(* Convert verification to boolean *)
isEqual = FullSimplify[verification] === True;
Print["Do they match? ", isEqual];
