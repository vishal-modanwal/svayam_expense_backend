import bcrypt from "bcryptjs";

const hashedPassword =async() =>{
const pass = await bcrypt.hash("admin@123" , 10);
console.log(pass);
} 

hashedPassword();