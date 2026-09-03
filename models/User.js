import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // username — used for login and shown in blast logs instead of email
    username: {
      type:      String,
      required:  true,
      unique:    true,
      lowercase: true,
      trim:      true,
      index:     true,
      // auto-derived from name if not provided (set in pre-save hook below)
    },
    email: {
      type:      String,
      required:  true,
      unique:    true,
      lowercase: true,
      trim:      true,
      index:     true,
    },
    passwordHash: { type: String, required: true },
    role:         { type: String, enum: ['user'], default: 'user' },
    lastLoginAt:  { type: Date },
  },
  { timestamps: true }
);

// Never allow accidental plaintext storage — this is the only write path.
userSchema.methods.setPassword = async function setPassword(plainPassword) {
  this.passwordHash = await bcrypt.hash(plainPassword, 12);
};

userSchema.methods.comparePassword = function comparePassword(plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

// Defense in depth: strip passwordHash from every JSON response.
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

export default mongoose.model('User', userSchema);